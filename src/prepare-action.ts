import { GitRepository } from "./git.ts";
import { validateSourcePlan } from "./source-tag.ts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { readReleaseConfig } from "./release-config.ts";
import { planRelease, saveReleasePlan, readReleasePlan, executeReleasePlan, resolveReleaseTag, bindReleaseTag } from "./release-execution.ts";
import { ReleaseError } from "./release-error.ts";
import { newDiagnostics, failDiagnostics, completeDiagnostics, writeDiagnostics } from "./diagnostics.ts";

export function runPrepare(env: NodeJS.ProcessEnv = process.env): void {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const mode = env.INPUT_MODE || "prepare";
  const modes = ["plan", "prepare", "resume", "resolve", "tag"] as const;
  const diagnostic = newDiagnostics("prepare", modes.includes(mode as typeof modes[number]) ? mode as typeof modes[number] : "prepare");
  const output = (values: Record<string, string>) => {
    const body = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, body);
    else process.stdout.write(body);
  };
  let failed = false;
  try {
    const allowPrerelease = (env.INPUT_ALLOW_PRERELEASE || "false").trim() || "false";
    const prefix = env.INPUT_TAG_PREFIX || "";
    if (!["true", "false"].includes(allowPrerelease) || (mode !== "resolve" && (allowPrerelease === "true" || prefix))) throw new ReleaseError("INVALID_INPUT", "allow-prerelease and tag-prefix are resolve-only inputs");
    if (mode === "resolve") {
      diagnostic.phase = "resolve";
      const release = resolveReleaseTag(workspace, env.INPUT_TAG || "", env.INPUT_BRANCH || "main", allowPrerelease !== "true", env.INPUT_COMMIT || "", prefix);
      Object.assign(diagnostic.selection, release);
      diagnostic.verification.remoteTag = "matched";
      output({ ...release, target: release.commit, state: "existing" });
    } else if (mode === "tag") {
      diagnostic.phase = "bind-tag";
      const release = bindReleaseTag(workspace, env.INPUT_TAG || "", env.INPUT_COMMIT || "", env.INPUT_BRANCH || "main");
      Object.assign(diagnostic.selection, { tag: release.tag, version: release.version, commit: release.commit });
      diagnostic.verification.remoteTag = "matched";
      output(release);
    } else {
      if (!["plan", "prepare", "resume"].includes(mode)) throw new ReleaseError("INVALID_INPUT", "mode must be plan, prepare, resume, resolve, or tag");
      let config;
      try { config = readReleaseConfig(workspace, env.INPUT_RELEASE_CONFIG || ".github/releaseway.yml"); }
      catch { throw new ReleaseError("CONFIG_INVALID", "Release configuration could not be read or validated"); }
      diagnostic.selection.strategy = config.strategy ?? "release-commit";
      diagnostic.phase = "plan";
      const path = env.INPUT_PLAN_PATH || join(env.RUNNER_TEMP || "/tmp", `releaseway-${env.GITHUB_RUN_ID || process.pid}-plan.json`);
      let plan = mode === "resume" ? readReleasePlan(path) : planRelease(workspace, config, env.INPUT_PRERELEASE_ID || "");
      if (mode === "resume" && plan.schema === 2) validateSourcePlan(new GitRepository(workspace), plan);
      Object.assign(diagnostic.selection, { source: plan.source, commit: plan.commit, tag: plan.tag, version: plan.version });
      diagnostic.verification.remoteTag = mode !== "resume" && plan.state === "existing" ? "matched" : "not-checked";
      saveReleasePlan(path, plan);
      output({ tag: plan.tag, version: plan.version, commit: plan.commit, source: plan.source, "plan-path": path, latest: config.latest, prerelease: String(Boolean(plan.prereleaseId)), state: plan.state });
      if (mode !== "plan") {
        diagnostic.phase = "bind-tag";
        plan = executeReleasePlan(workspace, plan, config);
        diagnostic.verification.remoteTag = "matched";
        saveReleasePlan(path, plan);
        output({ state: plan.state });
      }
    }
    completeDiagnostics(diagnostic);
  } catch (error) {
    failed = true;
    failDiagnostics(diagnostic, error, diagnostic.phase === "input" ? "INVALID_INPUT" : "INTERNAL_ERROR");
    throw error;
  } finally {
    try { writeDiagnostics(diagnostic, env); }
    catch (error) {
      if (!failed) throw error;
      console.warn("Diagnostics could not be saved; preserving the original failure. Inspect origin before retrying.");
    }
  }
}
