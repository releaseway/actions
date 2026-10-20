import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPrepare } from "../src/prepare-action.ts";
import { verifyRemoteTagBinding } from "../src/git.ts";
import { runAction } from "../src/action.ts";
import { newDiagnostics, failDiagnostics, writeDiagnostics } from "../src/diagnostics.ts";
import { ReleaseError, recoveries } from "../src/release-error.ts";
import { matchesSchema } from "../src/release-json.ts";
const schema = JSON.parse(readFileSync(new URL("../contracts/diagnostics-v1.schema.json", import.meta.url)));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const report = (output) => JSON.parse(readFileSync(readFileSync(output, "utf8").trim().split("\n").findLast((line) => line.startsWith("diagnostics-path=")).slice("diagnostics-path=".length)));

test("prepare diagnostics distinguish a read-only plan, tag binding and controlled failure", () => {
  const root = mkdtempSync(join(tmpdir(), "prepare-diagnostics-"));
  try {
    const origin = join(root, "origin.git"), work = join(root, "work");
    git(root, "init", "--bare", origin); git(root, "init", "-b", "main", work);
    git(work, "config", "user.name", "Fixture"); git(work, "config", "user.email", "fixture@example.invalid");
    git(work, "config", "core.hooksPath", "/dev/null"); git(work, "config", "commit.gpgsign", "false");
    writeFileSync(join(work, "policy.yml"), "strategy: source-tag\n");
    git(work, "add", "policy.yml"); git(work, "commit", "-m", "feat: first source"); git(work, "remote", "add", "origin", origin); git(work, "push", "origin", "main");
    const output = join(root, "output"), before = git(origin, "show-ref");
    const env = { GITHUB_WORKSPACE: work, GITHUB_OUTPUT: output, RUNNER_TEMP: root, INPUT_MODE: "plan", INPUT_RELEASE_CONFIG: "policy.yml", INPUT_PLAN_PATH: join(root, "plan.json") };
    runPrepare(env);
    const planned = report(output);
    assert.equal(matchesSchema(schema, planned), true);
    assert.equal(planned.status, "success"); assert.equal(planned.verification.remoteTag, "not-checked");
    assert.equal(planned.selection.source, planned.selection.commit);
    assert.equal(git(origin, "show-ref"), before);
    runPrepare({ ...env, INPUT_MODE: "resume" });
    assert.equal(report(output).verification.remoteTag, "matched");
    assert.equal(git(origin, "rev-parse", "refs/heads/main"), planned.selection.source);
    assert.throws(() => runPrepare({ ...env, INPUT_MODE: "resolve", INPUT_TAG: planned.selection.tag, INPUT_COMMIT: "a".repeat(40) }), { code: "TAG_COMMIT_MISMATCH" });
    const failed = report(output);
    assert.equal(matchesSchema(schema, failed), true);
    assert.equal(failed.error.code, "TAG_COMMIT_MISMATCH");
    assert.equal(failed.verification.remoteTag, "mismatched");
    assert.throws(() => runPrepare({ ...env, INPUT_ALLOW_PRERELEASE: "true" }), { code: "INVALID_INPUT" });
    assert.equal(report(output).error.remoteState, "unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all stable error codes expose fixed recovery metadata without raw messages", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-errors-"));
  try {
    for (const code of Object.keys(recoveries)) {
      const diagnostic = newDiagnostics("prepare", "resolve");
      failDiagnostics(diagnostic, new ReleaseError(code, "SECRET_SENTINEL_RAW_OUTPUT"));
      const path = writeDiagnostics(diagnostic, { RUNNER_TEMP: root });
      const data = readFileSync(path, "utf8");
      assert.equal(data.includes("SECRET_SENTINEL"), false);
      assert.equal(matchesSchema(schema, JSON.parse(data)), true);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("root diagnostics preserve the child publication failure and observed remote state", async () => {
  const root = mkdtempSync(join(tmpdir(), "root-diagnostics-")), output = join(root, "output");
  try {
    await assert.rejects(runAction({
      env: { GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "owner/repo", GITHUB_OUTPUT: output, RUNNER_TEMP: root, INPUT_TAG: "v1.2.0", INPUT_COMMIT: "b".repeat(40), INPUT_NOTES: "none" },
      actionPath: "/action", provenanceCheck() {}, api: { async releaseByTag() { return null; } },
      spawnPublisher(_command, _args, options) {
        writeFileSync(options.env.RELEASE_ACTIONS_DIAGNOSTICS_STATE, JSON.stringify({ code: "ARTIFACT_MISMATCH", phase: "verify", remoteState: "present", artifacts: "not-checked" }));
        return { status: 1 };
      },
    }), { code: "ARTIFACT_MISMATCH" });
    const diagnostic = report(output);
    assert.equal(matchesSchema(schema, diagnostic), true);
    assert.equal(diagnostic.error.remoteState, "present");
    assert.equal(diagnostic.phase, "verify");
    assert.equal(diagnostic.selection.source, null);
    assert.equal(diagnostic.selection.strategy, null);
    assert.equal(diagnostic.verification.publication, "not-checked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("root diagnostics classify real remote binding mismatch before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "root-binding-"));
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "config", "core.hooksPath", "/dev/null"); git(root, "config", "commit.gpgsign", "false");
    git(root, "commit", "--allow-empty", "-m", "fixture");
    git(root, "config", "tag.gpgsign", "false");
    git(root, "tag", "v1.2.0"); git(root, "remote", "add", "origin", root);
    const output = join(root, "output");
    await assert.rejects(runAction({
      env: { GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "owner/repo", GITHUB_OUTPUT: output, RUNNER_TEMP: root, INPUT_TAG: "v1.2.0", INPUT_COMMIT: "b".repeat(40), INPUT_NOTES: "none" },
      provenanceCheck(options) { verifyRemoteTagBinding({ ...options, expectedCommit: options.commit }); },
      spawnPublisher() { assert.fail("mismatched tag must not publish"); },
    }), { code: "TAG_COMMIT_MISMATCH" });
    assert.equal(report(output).verification.remoteTag, "mismatched");
    assert.equal(report(output).error.remoteState, "present");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
