import process from "node:process";

import { publicContract } from "./contract.ts";
import { errorMessage } from "./errors.ts";
import { verifyReleaseBody } from "./prepare.ts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { readReleaseConfig } from "./release-config.ts";
import { planRelease, saveReleasePlan, readReleasePlan, executeReleasePlan, resolveReleaseTag, resolveSeriesLatest, bindReleaseTag } from "./release-execution.ts";

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command === "release-prepare") {
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const mode = process.env.INPUT_MODE || "prepare";
    const output = (values: Record<string, string>) => {
      const body = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, body);
      else process.stdout.write(body);
    };
    if (mode === "resolve") {
      const release = resolveReleaseTag(workspace, process.env.INPUT_TAG || "", process.env.INPUT_BRANCH || "main");
      output({ ...release, target: release.commit, state: "existing" });
      return;
    }
    if (mode === "tag") {
      const release = bindReleaseTag(workspace, process.env.INPUT_TAG || "", process.env.INPUT_COMMIT || "", process.env.INPUT_BRANCH || "main");
      output(release);
      return;
    }
    if (!["plan", "prepare", "resume"].includes(mode)) throw new Error("mode must be plan, prepare, resume, resolve, or tag");
    const config = readReleaseConfig(workspace, process.env.INPUT_RELEASE_CONFIG || ".github/releaseway.yml");
    const path = process.env.INPUT_PLAN_PATH || join(process.env.RUNNER_TEMP || "/tmp", `releaseway-${process.env.GITHUB_RUN_ID || process.pid}-plan.json`);
    let plan = mode === "resume" ? readReleasePlan(path) : planRelease(workspace, config, process.env.INPUT_PRERELEASE_ID || "");
    saveReleasePlan(path, plan);
    output({ tag: plan.tag, version: plan.version, commit: plan.commit, source: plan.source, "plan-path": path, latest: config.latest, prerelease: String(Boolean(plan.prereleaseId)), state: plan.state });
    if (mode !== "plan") {
      plan = executeReleasePlan(workspace, plan, config);
      saveReleasePlan(path, plan);
      output({ state: plan.state });
    }
    return;
  }
  if (command === "resolve-series-latest") {
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const config = readReleaseConfig(workspace, process.env.INPUT_RELEASE_CONFIG || ".github/releaseway.yml");
    process.stdout.write(resolveSeriesLatest(workspace, config, process.env.INPUT_TAG || "", process.env.INPUT_COMMIT || "") + "\n");
    return;
  }
  if (command === "contract") {
    process.stdout.write(JSON.stringify(publicContract()) + "\n");
    return;
  }

  if (command === "verify-release-body") {
    const repository = argv[1];
    const releaseId = Number(argv[2]);
    const expectedPath = argv[3];
    if (
      !repository ||
      !Number.isInteger(releaseId) ||
      releaseId <= 0 ||
      !expectedPath
    ) {
      throw new Error(
        "verify-release-body requires repository, release id, and expected file",
      );
    }
    await verifyReleaseBody({
      repository,
      releaseId,
      expectedPath,
    });
    return;
  }

  throw new Error(
    command
      ? `unknown notes-engine command: ${command}`
      : "notes-engine command is required",
  );
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
