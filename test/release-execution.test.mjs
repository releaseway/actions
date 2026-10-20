import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitRepository } from "../src/git.ts";
import { parseReleaseConfig } from "../src/release-config.ts";
import { planRelease, executeReleasePlan, saveReleasePlan, readReleasePlan, resolveSeriesLatest, resolveReleaseTag, bindReleaseTag } from "../src/release-execution.ts";

const config = () => parseReleaseConfig(`schema: 1
series:
  base-tag: v11.0.4
  start-version: 1.2.0
latest: current-series
`);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
function repository(fn) {
  const root = mkdtempSync(join(tmpdir(), "releaseway-series-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "--bare", origin);
  git(origin, "config", "core.hooksPath", join(origin, "hooks"));
  git(root, "init", "-b", "main", work);
  git(work, "config", "user.name", "Fixture");
  git(work, "config", "user.email", "fixture@example.invalid");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "config", "tag.gpgsign", "false");
  git(work, "config", "core.hooksPath", "/dev/null");
  git(work, "remote", "add", "origin", origin);
  writeFileSync(join(work, "source.txt"), "old\n");
  git(work, "add", "source.txt");
  git(work, "commit", "-m", "feat: old series");
  git(work, "tag", "v11.0.4");
  const base = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "source.txt"), "new\n");
  git(work, "commit", "-am", "feat!: restart series");
  git(work, "push", "origin", "main", "--tags");
  try { fn({ root, origin, work, base }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("restart retains old tags, calculates exact start then patch, and resumes deterministic release commits", () => repository(({ root, origin, work, base }) => {
  const source = git(work, "rev-parse", "HEAD");
  const first = planRelease(work, config());
  assert.equal(first.version, "1.2.0");
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), source);
  const path = join(root, "plan.json");
  saveReleasePlan(path, first);
  executeReleasePlan(work, readReleasePlan(path), config());
  assert.equal(git(origin, "rev-parse", "refs/tags/v11.0.4"), base);
  assert.equal(git(origin, "rev-parse", "refs/tags/v1.2.0"), first.commit);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), first.commit);
  assert.equal(planRelease(work, config()).state, "existing");
  executeReleasePlan(work, first, config());
  git(work, "reset", "--hard", first.commit);
  assert.equal(planRelease(work, config()).tag, first.tag);
  assert.equal(resolveSeriesLatest(work, config(), first.tag, first.commit), "true");
  assert.equal(resolveReleaseTag(work, first.tag).commit, first.commit);
  git(work, "commit", "--allow-empty", "-m", "fix: new patch");
  git(work, "push", "origin", "main");
  const next = planRelease(work, config());
  assert.equal(next.version, "1.2.1");
  executeReleasePlan(work, next, config());
  assert.equal(resolveSeriesLatest(work, config(), first.tag, first.commit), "false");
  assert.equal(resolveSeriesLatest(work, config(), next.tag, next.commit), "true");
  assert.throws(() => resolveSeriesLatest(work, config(), "v11.0.4", base), /outside the current series/);
}));

test("explicit native tag bindings are retryable and never replace existing tags", () => repository(({ origin, work, base }) => {
  const source = git(work, "rev-parse", "HEAD");
  const tag = "native-v1.2.0-rc.0";
  assert.equal(bindReleaseTag(work, tag, source).state, "created");
  assert.equal(bindReleaseTag(work, tag, source).state, "existing");
  assert.throws(() => bindReleaseTag(work, tag, base), /will not be replaced/);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), source);
}));

test("atomic push rejection leaves branch and tag untouched; saved plan resumes after recovery", () => repository(({ root, origin, work }) => {
  const plan = planRelease(work, config());
  const hook = join(origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
  assert.throws(() => executeReleasePlan(work, plan, config()), /Atomic release push failed/);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), plan.source);
  assert.throws(() => git(origin, "rev-parse", "refs/tags/v1.2.0"));
  rmSync(hook);
  assert.equal(executeReleasePlan(work, plan, config()).commit, plan.commit);
}));

test("stale plans and altered plan identities cannot overwrite concurrent work", () => repository(({ origin, work }) => {
  const plan = planRelease(work, config());
  assert.throws(() => executeReleasePlan(work, { ...plan, tag: "v2.0.0" }, config()), /plan tag changed/);
  git(work, "commit", "--allow-empty", "-m", "fix: concurrent writer");
  const other = git(work, "rev-parse", "HEAD");
  git(work, "push", "origin", "main");
  assert.throws(() => executeReleasePlan(work, plan, config()), /requires checkout of its source/);
  git(work, "reset", "--hard", plan.source);
  assert.throws(() => executeReleasePlan(work, plan, config()), /Origin branch differs/);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), other);
}));

test("restart rejects historical tag collisions and invalid or unreachable boundaries", () => repository(({ work }) => {
  git(work, "tag", "v1.2.0", "v11.0.4");
  git(work, "push", "origin", "refs/tags/v1.2.0");
  assert.throws(() => planRelease(work, config()), /will not be replaced/);
  assert.throws(() => planRelease(work, { ...config(), series: { baseTag: "missing", startVersion: "1.2.0" } }), /base tag does not exist/);
  assert.throws(() => parseReleaseConfig("schema: 1\nseries:\n  base-tag: v11.0.4\n  start-version: 1.2.0-rc.1\n"), /stable SemVer/);
}));

test("prerelease series increments and promotes stable without marking prerelease latest", () => repository(({ work }) => {
  const first = planRelease(work, config(), "rc");
  assert.equal(first.version, "1.2.0-rc.0");
  assert.equal(first.latest, "false");
  executeReleasePlan(work, first, config());
  git(work, "reset", "--hard", first.commit);
  assert.throws(() => planRelease(work, config()), /Retry prerelease-id differs/);
  git(work, "commit", "--allow-empty", "-m", "fix: next prerelease");
  git(work, "push", "origin", "main");
  const next = planRelease(work, config(), "rc");
  assert.equal(next.version, "1.2.0-rc.1");
  executeReleasePlan(work, next, config());
  git(work, "reset", "--hard", next.commit);
  git(work, "commit", "--allow-empty", "-m", "chore: promote stable");
  git(work, "push", "origin", "main");
  assert.equal(planRelease(work, config()).version, "1.2.0");
}));

test("resolve is read-only for prerelease, custom prefix, expected commit and invalid bindings", () => repository(({ origin, work, base }) => {
  const source = git(work, "rev-parse", "HEAD");
  git(work, "tag", "-a", "native-v1.2.0-rc.0", "-m", "fixture");
  git(work, "tag", "x01.2.3");
  git(work, "push", "origin", "--tags");
  const before = git(origin, "show-ref");
  assert.throws(() => resolveReleaseTag(work, "native-v1.2.0-rc.0"), { code: "TAG_INVALID" });
  assert.equal(resolveReleaseTag(work, "native-v1.2.0-rc.0", "main", false, source).version, "1.2.0-rc.0");
  assert.throws(() => resolveReleaseTag(work, "native-v1.2.0-rc.0", "main", false, base), { code: "TAG_COMMIT_MISMATCH" });
  assert.throws(() => resolveReleaseTag(work, "v1.2.0-rc.1", "main", false), { code: "TAG_NOT_FOUND" });
  assert.throws(() => resolveReleaseTag(work, "01.2.3"), { code: "TAG_INVALID" });
  assert.throws(() => resolveReleaseTag(work, "x01.2.3"), { code: "TAG_INVALID" });
  assert.equal(resolveReleaseTag(work, "x01.2.3", "main", true, "", "x0").version, "1.2.3");
  assert.equal(git(origin, "show-ref"), before);
}));

const sourceConfig = () => ({ ...config(), strategy: "source-tag" });

test("source-tag leaves branch unchanged, resumes saved plan and recovers without the plan file", () => repository(({ root, origin, work }) => {
  const source = git(work, "rev-parse", "HEAD");
  const plan = planRelease(work, sourceConfig(), "rc");
  assert.equal(plan.schema, 2);
  assert.equal(plan.commit, source);
  assert.notEqual(plan.tagObject, source);
  const path = join(root, "source-plan.json");
  saveReleasePlan(path, plan);
  assert.equal(executeReleasePlan(work, readReleasePlan(path), sourceConfig()).state, "existing");
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), source);
  assert.equal(git(origin, "cat-file", "-t", "refs/tags/" + plan.tag), "tag");
  assert.equal(git(origin, "rev-parse", `refs/tags/${plan.tag}^{commit}`), source);
  rmSync(path);
  assert.equal(planRelease(work, sourceConfig(), "rc").tagObject, plan.tagObject);
  assert.equal(executeReleasePlan(work, plan, sourceConfig()).tag, plan.tag);
}));

test("source-tag increments on new source, promotes same-source stable and closes automatic rc planning", () => repository(({ origin, work }) => {
  const first = planRelease(work, sourceConfig(), "rc");
  executeReleasePlan(work, first, sourceConfig());
  git(work, "commit", "--allow-empty", "-m", "fix: next prerelease");
  git(work, "push", "origin", "main");
  const next = planRelease(work, sourceConfig(), "rc");
  assert.equal(next.version, "1.2.0-rc.1");
  executeReleasePlan(work, next, sourceConfig());
  const stable = planRelease(work, sourceConfig());
  assert.equal(stable.source, next.source);
  assert.equal(stable.version, "1.2.0");
  executeReleasePlan(work, stable, sourceConfig());
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), next.source);
  assert.throws(() => planRelease(work, sourceConfig(), "rc"), { code: "CHANNEL_CLOSED" });
  assert.equal(executeReleasePlan(work, next, sourceConfig()).version, next.version);
}));

test("source-tag rejects changed policies, tampered plans and manual tag adoption", () => repository(({ origin, work }) => {
  const plan = planRelease(work, sourceConfig(), "rc");
  assert.throws(() => executeReleasePlan(work, { ...plan, source: "a".repeat(40) }, sourceConfig()), { code: "PLAN_INVALID" });
  assert.throws(() => executeReleasePlan(work, { ...plan, unknown: true }, sourceConfig()), { code: "PLAN_INVALID" });
  assert.throws(() => executeReleasePlan(work, { ...plan, tagObject: "a".repeat(40) }, sourceConfig()), { code: "PLAN_INVALID" });
  assert.throws(() => executeReleasePlan(work, plan, config()), { code: "PLAN_CONFIG_MISMATCH" });
  git(work, "tag", plan.tag);
  git(work, "push", "origin", `refs/tags/${plan.tag}`);
  assert.throws(() => executeReleasePlan(work, plan, sourceConfig()), { code: "TAG_CONFLICT" });
  assert.equal(git(origin, "rev-parse", `refs/tags/${plan.tag}`), plan.source);
}));

test("source-tag stale writers fail and rejected pushes can resume the saved identity", () => repository(({ origin, work }) => {
  const plan = planRelease(work, sourceConfig());
  const hook = join(origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
  assert.throws(() => executeReleasePlan(work, plan, sourceConfig()), { code: "REMOTE_REJECTED" });
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), plan.source);
  rmSync(hook);
  executeReleasePlan(work, plan, sourceConfig());
  assert.throws(() => planRelease(work, { ...sourceConfig(), bump: "minor" }), { code: "IDENTITY_CONFLICT" });
  git(work, "commit", "--allow-empty", "-m", "fix: later"); git(work, "push", "origin", "main");
  const stale = planRelease(work, sourceConfig());
  git(work, "commit", "--allow-empty", "-m", "fix: concurrent"); git(work, "push", "origin", "main");
  git(work, "reset", "--hard", stale.source);
  assert.throws(() => executeReleasePlan(work, stale, sourceConfig()), { code: "PLAN_STALE" });
  git(work, "reset", "--hard", plan.source);
  assert.equal(executeReleasePlan(work, plan, sourceConfig()).state, "existing");
}));

test("source-tag strict JSON rejects duplicate fields and future schemas", () => repository(({ root, work }) => {
  const plan = planRelease(work, sourceConfig());
  const path = join(root, "invalid.json");
  writeFileSync(path, JSON.stringify(plan).replace('"schema":2', '"schema":2,"schema":2'));
  assert.throws(() => readReleasePlan(path), { code: "PLAN_INVALID" });
  writeFileSync(path, JSON.stringify({ ...plan, schema: 3 }));
  assert.throws(() => readReleasePlan(path), { code: "PLAN_INVALID" });
}));

test("release config schema omission and explicit release-commit preserve legacy serialization", () => {
  const body = "branch: main\nbump: patch\n";
  assert.deepEqual(parseReleaseConfig(body), parseReleaseConfig("schema: 1\n" + body));
  assert.deepEqual(parseReleaseConfig(body), parseReleaseConfig("strategy: release-commit\n" + body));
  for (const value of ["null", "true", '"1"', "2", '""']) assert.throws(() => parseReleaseConfig(`schema: ${value}\n` + body), /schema/);
});

test("source-tag verifies accepted pushes after a lost response and identical writers converge", () => repository(({ work }) => {
  const first = planRelease(work, sourceConfig());
  const second = planRelease(work, sourceConfig());
  assert.equal(first.tagObject, second.tagObject);
  const run = GitRepository.prototype.run;
  try {
    GitRepository.prototype.run = function(args, options) {
      const result = run.call(this, args, options);
      return args[0] === "push" && result.status === 0 ? { ...result, status: 1, stderr: "simulated lost response after accepted write" } : result;
    };
    assert.equal(executeReleasePlan(work, first, sourceConfig()).state, "existing");
  } finally { GitRepository.prototype.run = run; }
  assert.equal(executeReleasePlan(work, second, sourceConfig()).tagObject, first.tagObject);
}));

test("source-tag detects branch movement after tag creation without deleting the accepted tag", () => repository(({ origin, work }) => {
  const plan = planRelease(work, sourceConfig());
  const tree = git(work, "rev-parse", "HEAD^{tree}");
  const later = git(work, "commit-tree", tree, "-p", plan.source, "-m", "fix: concurrent source");
  git(work, "push", "origin", `${later}:refs/fixture/concurrent`);
  const run = GitRepository.prototype.run;
  try {
    GitRepository.prototype.run = function(args, options) {
      const result = run.call(this, args, options);
      if (args[0] === "push" && result.status === 0) git(origin, "update-ref", "refs/heads/main", later);
      return result;
    };
    assert.throws(() => executeReleasePlan(work, plan, sourceConfig()), { code: "PLAN_STALE", remoteState: "present" });
  } finally { GitRepository.prototype.run = run; }
  assert.equal(git(origin, "rev-parse", "refs/tags/" + plan.tag), plan.tagObject);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), later);
  assert.equal(executeReleasePlan(work, plan, sourceConfig()).state, "existing");
}));

test("source-tag refuses multiple canonical records for one source/channel", () => repository(({ work }) => {
  const plan = planRelease(work, sourceConfig());
  executeReleasePlan(work, plan, sourceConfig());
  const raw = git(work, "cat-file", "tag", plan.tagObject);
  const marker = "Releaseway-Source-Tag: 1\n\n";
  const offset = raw.indexOf(marker);
  const annotation = JSON.parse(raw.slice(offset + marker.length));
  annotation.tag = "v1.2.1"; annotation.version = "1.2.1";
  const payload = raw.slice(0, offset).replace("tag v1.2.0\n", "tag v1.2.1\n") + marker + JSON.stringify(annotation) + "\n";
  const id = execFileSync("git", ["-C", work, "hash-object", "-w", "-t", "tag", "--stdin"], { input: payload, encoding: "utf8" }).trim();
  git(work, "push", "origin", `${id}:refs/tags/v1.2.1`);
  assert.throws(() => planRelease(work, sourceConfig()), { code: "IDENTITY_CONFLICT" });
}));


test("legacy atomic release and explicit tag inspect origin after accepted push timeout", () => repository(({ work, origin }) => {
  const plan = planRelease(work, config());
  const run = GitRepository.prototype.run;
  try {
    GitRepository.prototype.run = function(args, options) {
      const result = run.call(this, args, options);
      if (args[0] === "push" && result.status === 0) throw new Error("simulated accepted push timeout");
      return result;
    };
    assert.equal(executeReleasePlan(work, plan, config()).state, "existing");
    assert.equal(bindReleaseTag(work, "native-v1.2.0", plan.commit).state, "created");
  } finally { GitRepository.prototype.run = run; }
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), plan.commit);
  assert.equal(git(origin, "rev-parse", "refs/tags/native-v1.2.0"), plan.commit);
}));

test("source-tag catches a second canonical channel identity created during push", () => repository(({ work, origin }) => {
  const plan = planRelease(work, sourceConfig());
  const run = GitRepository.prototype.run;
  try {
    GitRepository.prototype.run = function(args, options) {
      const result = run.call(this, args, options);
      if (args[0] === "push" && result.status === 0) {
        const raw = git(work, "cat-file", "tag", plan.tagObject);
        const marker = "Releaseway-Source-Tag: 1\n\n";
        const offset = raw.indexOf(marker);
        const annotation = JSON.parse(raw.slice(offset + marker.length));
        annotation.tag = "v1.2.1"; annotation.version = "1.2.1";
        const payload = raw.slice(0, offset).replace("tag v1.2.0\n", "tag v1.2.1\n") + marker + JSON.stringify(annotation) + "\n";
        const id = execFileSync("git", ["-C", work, "hash-object", "-w", "-t", "tag", "--stdin"], { input: payload, encoding: "utf8" }).trim();
        git(work, "push", "origin", `${id}:refs/tags/v1.2.1`);
      }
      return result;
    };
    assert.throws(() => executeReleasePlan(work, plan, sourceConfig()), { code: "IDENTITY_CONFLICT", remoteState: "present" });
  } finally { GitRepository.prototype.run = run; }
  assert.equal(git(origin, "rev-parse", `refs/tags/${plan.tag}`), plan.tagObject);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), plan.source);
}));

test("decreasing source-tag prerelease channels fail as invalid input without writes", () => repository(({ work, origin }) => {
  executeReleasePlan(work, planRelease(work, sourceConfig(), "rc"), sourceConfig());
  const before = git(origin, "show-ref");
  assert.throws(() => planRelease(work, sourceConfig(), "beta"), { code: "INVALID_INPUT" });
  assert.equal(git(origin, "show-ref"), before);
}));

test("legacy saved plan rejects output injection before returning its fields", () => repository(({ root, work }) => {
  const plan = planRelease(work, config());
  const path = join(root, "invalid-legacy.json");
  for (const changed of [{ tag: "v1.2.0\nother=value" }, { source: "bad" }, { prereleaseId: "rc" }, { latest: "bad" }]) {
    writeFileSync(path, JSON.stringify({ ...plan, ...changed }));
    assert.throws(() => readReleasePlan(path), { code: "PLAN_INVALID" });
  }
  chmodSync(path, 0o644);
  saveReleasePlan(path, plan);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readReleasePlan(path), plan);
}));
