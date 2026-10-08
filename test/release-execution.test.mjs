import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
