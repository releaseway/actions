import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitRepository } from "../src/git.ts";
import { validateSourcePlan } from "../src/source-tag.ts";
import { planRelease, executeReleasePlan } from "../src/release-execution.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/release-contract/${name}.json`, import.meta.url), "utf8"));
const git = (cwd, args, input) => execFileSync("git", ["-C", cwd, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

test("legacy source/config produces the independently fixed v0.5.1 marker SHA and schema 1 resume", () => {
  const f = fixture("legacy-marker");
  assert.equal(createHash("sha256").update(JSON.stringify(f.config)).digest("hex"), f.configDigest);
  const root = mkdtempSync(join(tmpdir(), "release-contract-"));
  try {
    const origin = join(root, "origin.git"), work = join(root, "work");
    git(root, ["init", "--bare", origin]);
    git(root, ["init", "-b", "main", work]);
    git(work, ["config", "core.hooksPath", "/dev/null"]);
    git(work, ["hash-object", "-w", "-t", "tree", "--stdin"], "");
    assert.equal(git(work, ["hash-object", "-w", "-t", "commit", "--stdin"], f.sourceObject), f.source);
    git(work, ["update-ref", "refs/heads/main", f.source]);
    git(work, ["remote", "add", "origin", origin]);
    git(work, ["push", "origin", "main"]);
    const plan = planRelease(work, f.config);
    assert.equal(plan.schema, 1);
    assert.equal(plan.commit, f.marker);
    assert.equal(plan.tag, f.tag);
    executeReleasePlan(work, JSON.parse(JSON.stringify(plan)), f.config);
    assert.equal(planRelease(work, f.config).commit, f.marker);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source-tag contract examples fix policy digest and separate source and tag object identities", () => {
  const plan = fixture("source-plan-v2"), tag = fixture("source-tag-v1");
  assert.equal(plan.schema, 2);
  assert.equal(tag.schema, 1);
  assert.equal(plan.source, plan.commit);
  assert.equal(plan.source, tag.source);
  assert.notEqual(plan.tagObject, plan.commit);
  assert.equal(createHash("sha256").update(JSON.stringify(tag.config)).digest("hex"), plan.policyDigest);
  assert.equal(plan.policyDigest, tag.policyDigest);
  for (const name of ["source-plan-v2", "source-tag-v1", "diagnostics-v1"]) {
    const schema = JSON.parse(readFileSync(new URL(`../contracts/${name}.schema.json`, import.meta.url), "utf8"));
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes("schema"));
    assert.deepEqual(Object.keys(fixture(name)).sort(), schema.required.toSorted());
  }
});

// Example tagObject was fixed before implementation, including the tagger time.
test("source-tag executor accepts the exact external plan and annotation canonicalization", () => {
  const git = new GitRepository("/unused");
  git.run = () => ({ stdout: "1700000000\n", status: 0 });
  const plan = fixture("source-plan-v2");
  assert.deepEqual(validateSourcePlan(git, plan), plan);
  assert.throws(() => validateSourcePlan(git, { ...plan, tagObject: "a".repeat(40) }), { code: "PLAN_INVALID" });
});
