import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

test("App-free template connects exact plans/builds and optional delivery through one run", () => {
  const text = readFileSync(new URL("../examples/app-free-release.yml", import.meta.url), "utf8");
  const doc = parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(doc.errors, []);
  const workflow = doc.toJS(), jobs = workflow.jobs;
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(jobs.build.needs, "plan");
  assert.deepEqual(jobs.release.needs, ["plan", "build"]);
  assert.deepEqual(jobs.npm.needs, ["plan", "release"]);
  assert.deepEqual(jobs.npm.permissions, { contents: "read", "id-token": "write" });
  assert.deepEqual(jobs.release.permissions, { contents: "write" });
  const plan = jobs.plan.steps.find((step) => step.id === "plan");
  assert.equal(plan.with.mode, "plan");
  const resume = jobs.release.steps.find((step) => step.id === "resume");
  assert.equal(resume.with.mode, "resume");
  const downloads = jobs.release.steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(downloads.map((step) => step.with["artifact-ids"]), ["${{ needs.plan.outputs.plan-artifact-id }}", "${{ needs.build.outputs.artifact-id }}"]);
  assert.ok(downloads.every((step) => step.with["digest-mismatch"] === "error"));
  assert.equal(jobs.npm.steps.find((step) => step.id === "npm").with["release-tag"], "${{ needs.release.outputs.tag }}");
  assert.deepEqual(jobs.homebrew.secrets, { tap_deploy_key: "${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}" });
  assert.equal(jobs.pages.with.tag, "${{ needs.release.outputs.tag }}");
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.run) assert.equal(spawnSync("bash", ["-n"], { input: step.run }).status, 0);
    }
  }
  assert.doesNotMatch(text, /create-github-app-token|secrets\.[A-Z_]*(?:APP|PAT)|actions: write|workflow_run:|repository_dispatch:|git ls-remote|jq /);
  assert.doesNotMatch(text, /UNRELEASED CONTRACT|0{40}|replace before use/);
  for (const job of Object.values(jobs)) {
    if (job.uses) assert.match(job.uses, /@[a-f0-9]{40}$/);
  }
});
