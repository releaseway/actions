import { planSourceRelease, executeSourcePlan, type SourceReleasePlan } from "./source-tag.ts";
import { parseReleaseJson } from "./release-json.ts";
import { ReleaseError } from "./release-error.ts";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { valid, prerelease, compare } from "semver";
import { GitRepository } from "./git.ts";
import type { ReleaseConfig } from "./release-config.ts";
import { nextSeriesVersion, seriesTags, type SeriesTag } from "./series.ts";
import { parseVersionedTag } from "./range.ts";

export interface LegacyReleasePlan {
  schema: 1;
  config: ReleaseConfig;
  source: string;
  commit: string;
  tag: string;
  version: string;
  prereleaseId: string;
  latest: "automatic" | "true" | "false";
  state: "planned" | "existing";
}

export type ReleasePlan = LegacyReleasePlan | SourceReleasePlan;

const digest = (config: ReleaseConfig) => createHash("sha256").update(JSON.stringify(config)).digest("hex");

function validateRefs(git: GitRepository, config: ReleaseConfig): void {
  try {
    git.run(["check-ref-format", `refs/heads/${config.branch}`]);
    git.run(["check-ref-format", `refs/tags/${config.tagPrefix}0.0.0`]);
    if (config.series) git.run(["check-ref-format", `refs/tags/${config.series.baseTag}`]);
  } catch {
    throw new ReleaseError("CONFIG_INVALID", "Release policy contains an invalid branch, tag prefix, or series ref");
  }
}

export function snapshot(git: GitRepository, config: ReleaseConfig): { branch: string; tags: SeriesTag[] } {
  validateRefs(git, config);
  let refs: string;
  try { refs = git.run(["ls-remote", "origin", `refs/heads/${config.branch}`, "refs/tags/*"]).stdout; }
  catch { throw new ReleaseError("REMOTE_UNAVAILABLE", "Origin release state could not be read"); }
  const entries = new Map<string, { direct?: string; peeled?: string }>();
  let branch = "";
  for (const line of refs.trim().split("\n")) {
    const [sha, ref] = line.split(/\s+/);
    if (!sha || !ref || !/^[0-9a-f]{40}$/.test(sha)) continue;
    if (ref === `refs/heads/${config.branch}`) branch = sha;
    else if (ref.startsWith("refs/tags/")) {
      const peeled = ref.endsWith("^{}");
      const name = ref.slice(10, peeled ? -3 : undefined);
      const tag = entries.get(name) ?? {};
      if (peeled) tag.peeled = sha;
      else tag.direct = sha;
      entries.set(name, tag);
    }
  }
  if (!branch) throw new ReleaseError("NOT_ON_BRANCH", `Origin branch does not exist: ${config.branch}`);
  // Private evidence refs never overwrite user tags or branches.
  try { git.run(["fetch", "--no-tags", "origin", `+refs/heads/${config.branch}:refs/releaseway/branch`, "+refs/tags/*:refs/releaseway/tags/*"]); }
  catch { throw new ReleaseError("REMOTE_UNAVAILABLE", "Origin release evidence could not be fetched"); }
  if (git.resolveCommit("refs/releaseway/branch") !== branch) throw new ReleaseError("PLAN_STALE", "Origin branch changed while reading release state; retry planning");
  const tags: SeriesTag[] = [];
  for (const [tag, entry] of entries) {
    const commit = entry.peeled ?? entry.direct!;
    if (git.resolveCommit(`refs/releaseway/tags/${tag}`) !== commit) throw new ReleaseError("TAG_CONFLICT", `Origin tag changed while reading release state: ${tag}`, "present");
    tags.push({ tag, commit });
  }
  return { branch, tags };
}

function releaseCommit(git: GitRepository, source: string, tag: string, config: ReleaseConfig): string {
  const tree = git.run(["rev-parse", `${source}^{tree}`]).stdout.trim();
  const timestamp = Number(git.run(["show", "-s", "--format=%ct", source]).stdout.trim()) + 1;
  const result = spawnSync("git", ["-C", git.path, "commit-tree", tree, "-p", source], {
    input: `chore(release): ${tag}\n\nReleaseway-Config: ${digest(config)}\n`,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "github-actions[bot]", GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "github-actions[bot]", GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_AUTHOR_DATE: `${timestamp} +0000`, GIT_COMMITTER_DATE: `${timestamp} +0000`,
    },
  });
  if (result.error || result.status !== 0) throw new Error(`Could not create release commit: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

export function latestPolicy(config: ReleaseConfig, version: string): ReleasePlan["latest"] {
  if (config.latest === "current-series") return prerelease(version) === null ? "true" : "false";
  if (config.latest === "true" && prerelease(version) !== null) throw new ReleaseError("CONFIG_INVALID", "Prerelease cannot be marked latest");
  return config.latest;
}

export function planRelease(workspace: string, config: ReleaseConfig, prereleaseId = "", explicitSource?: string): ReleasePlan {
  if (config.strategy === "source-tag") return planSourceRelease(workspace, config, prereleaseId, explicitSource);
  const git = new GitRepository(workspace);
  if (git.run(["status", "--porcelain", "--untracked-files=no"]).stdout.trim()) throw new ReleaseError("INVALID_INPUT", "Release planning requires clean tracked source files");
  const remote = snapshot(git, config);
  const head = explicitSource ?? git.resolveCommit("HEAD");
  if (!/^[0-9a-f]{40}$/.test(head)) throw new ReleaseError("INVALID_INPUT", "Release source must be a full commit SHA");
  const message = git.run(["show", "-s", "--format=%B", head]).stdout.trim();
  const marker = message.match(/^chore\(release\): (\S+)\n\nReleaseway-Config: ([0-9a-f]{64})$/);
  if (!explicitSource && marker && marker[2] === digest(config)) {
    const tag = marker[1]!;
    const source = git.resolveCommit(`${head}^`);
    if (releaseCommit(git, source, tag, config) !== head) throw new Error("Release marker does not match deterministic release commit");
    const existing = remote.tags.find((entry) => entry.tag === tag);
    if (existing?.commit !== head || !git.isAncestor(head, remote.branch)) throw new Error("Release marker is not committed on origin with its matching tag");
    const version = tag.slice(config.tagPrefix.length);
    if (!tag.startsWith(config.tagPrefix) || valid(version) !== version) throw new Error("Release marker has an invalid version tag");
    if ((prerelease(version)?.[0] ?? "") !== prereleaseId) throw new ReleaseError("INVALID_INPUT", "Retry prerelease-id differs from the prepared release");
    return { schema: 1, config, source, commit: head, tag, version, prereleaseId, latest: latestPolicy(config, version), state: "existing" };
  }
  const eligible = seriesTags(config, remote.tags, head, (a, b) => git.isAncestor(a, b));
  eligible.sort((a, b) => compare(a.tag.slice(config.tagPrefix.length), b.tag.slice(config.tagPrefix.length)));
  const previous = eligible.at(-1);
  const base = previous?.commit ?? (config.series ? remote.tags.find((entry) => entry.tag === config.series!.baseTag)!.commit : null);
  const messages = git.run(["log", "--format=%B%x00", ...(base ? [`${base}..${head}`] : [head])]).stdout.split("\0").filter((value) => value.trim());
  const version = nextSeriesVersion(config, eligible, messages.map((message) => message.trim()), prereleaseId);
  const tag = config.tagPrefix + version;
  git.run(["check-ref-format", `refs/tags/${tag}`]);
  const commit = releaseCommit(git, head, tag, config);
  const existing = remote.tags.find((entry) => entry.tag === tag);
  if (existing && existing.commit !== commit) throw new ReleaseError("TAG_CONFLICT", `Release tag already exists and will not be replaced: ${tag}`, "present");
  if (!existing && remote.branch !== head) throw new ReleaseError("PLAN_STALE", "Origin branch differs from the release source; refresh checkout before planning");
  if (existing && !git.isAncestor(commit, remote.branch)) throw new Error("Matching release tag is not on the configured origin branch");
  return { schema: 1, config, source: head, commit, tag, version, prereleaseId, latest: latestPolicy(config, version), state: existing ? "existing" : "planned" };
}

export function saveReleasePlan(path: string, plan: ReleasePlan): void {
  const text = JSON.stringify(plan, null, 2) + "\n";
  if (plan.schema === 2 && Buffer.byteLength(text) > 256 * 1024) throw new ReleaseError("PLAN_INVALID", "Source-tag plan exceeds 256 KiB");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readReleasePlan(path: string): ReleasePlan {
  try {
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8")) as ReleasePlan;
    if (value?.schema === 2) return parseReleaseJson(bytes) as SourceReleasePlan;
    if (value?.schema !== 1) throw new ReleaseError("PLAN_INVALID", "Unknown release plan schema");
    if (!/^[0-9a-f]{40}$/.test(value.source) || !/^[0-9a-f]{40}$/.test(value.commit) ||
        typeof value.version !== "string" || valid(value.version) !== value.version || value.version.includes("+") ||
        typeof value.prereleaseId !== "string" || (prerelease(value.version)?.[0] ?? "") !== value.prereleaseId ||
        !["planned", "existing"].includes(value.state) || !["automatic", "true", "false"].includes(value.latest) ||
        !value.config || value.config.schema !== 1 || typeof value.config.tagPrefix !== "string" ||
        value.tag !== value.config.tagPrefix + value.version || /[\s\x00-\x1f\x7f]/.test(value.tag)) {
      throw new ReleaseError("PLAN_INVALID", "Invalid legacy release plan identity");
    }
    return value;
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError("PLAN_INVALID", "Release plan could not be read as valid JSON");
  }
}

export function executeReleasePlan(workspace: string, plan: ReleasePlan, config: ReleaseConfig): ReleasePlan {
  if (plan.schema === 2) return executeSourcePlan(workspace, plan, config);
  if (config.strategy === "source-tag") throw new ReleaseError("PLAN_CONFIG_MISMATCH", "Legacy plan requires release-commit strategy");
  if (plan.schema !== 1 || JSON.stringify(plan.config) !== JSON.stringify(config)) throw new ReleaseError("PLAN_CONFIG_MISMATCH", "Release plan configuration changed; create a fresh plan");
  const git = new GitRepository(workspace);
  const checkout = git.resolveCommit("HEAD");
  if (checkout !== plan.source && checkout !== plan.commit) throw new ReleaseError("PLAN_STALE", "Saved release plan requires checkout of its source or marker commit; unrelated source cannot be used to resume");
  const fresh = planRelease(workspace, config, plan.prereleaseId, plan.source);
  for (const key of ["source", "commit", "tag", "version", "latest"] as const) {
    if (fresh[key] !== plan[key]) throw new ReleaseError("PLAN_STALE", `Release plan ${key} changed; create a fresh plan`);
  }
  if (fresh.state === "existing") return fresh;
  let rejected = false;
  try {
    const result = git.run(["push", "--atomic", "--no-follow-tags", `--force-with-lease=refs/heads/${config.branch}:${plan.source}`, "origin", `${plan.commit}:refs/heads/${config.branch}`, `${plan.commit}:refs/tags/${plan.tag}`], { allowFailure: true });
    rejected = result.status !== 0 && /remote rejected|\[rejected\]|hook declined|permission denied|authentication failed/i.test(result.stderr ?? "");
  } catch {
    // A timeout can follow an accepted atomic transaction. Inspect origin first.
  }
  let remote: ReturnType<typeof snapshot>;
  try { remote = snapshot(git, config); }
  catch { throw new ReleaseError("REMOTE_UNCERTAIN", "Atomic release push outcome could not be verified; resume using the saved plan after checking origin", "unknown"); }
  const bound = remote.tags.find((tag) => tag.tag === plan.tag);
  if (bound?.commit === plan.commit && git.isAncestor(plan.commit, remote.branch)) return { ...fresh, state: "existing" };
  if (bound) throw new ReleaseError("TAG_CONFLICT", "Atomic release tag differs from its saved binding; inspect origin before resuming", "present");
  throw new ReleaseError(rejected ? "REMOTE_REJECTED" : "REMOTE_UNCERTAIN", "Atomic release push failed; no refs are rolled back or overwritten. Resume using the saved plan after checking origin.", rejected ? "unchanged" : "unknown");
}

export function resolveReleaseTag(workspace: string, tag: string, branch = "main", stableOnly = true, expectedCommit = "", tagPrefix = ""): { tag: string; version: string; commit: string } {
  const git = new GitRepository(workspace);
  if (expectedCommit && !/^[0-9a-f]{40}$/.test(expectedCommit)) throw new ReleaseError("INVALID_INPUT", "Expected commit must be a full lowercase 40-character SHA");
  if (/\s|[\x00-\x1f\x7f]/.test(tagPrefix)) throw new ReleaseError("INVALID_INPUT", "tag-prefix must not contain whitespace or control characters");
  if (tag.startsWith("refs/tags/") || git.run(["check-ref-format", `refs/tags/${tag}`], { allowFailure: true }).status !== 0) throw new ReleaseError("TAG_INVALID", "Release tag must be an exact Git tag name");
  let version: string;
  if (tagPrefix) {
    if (!tag.startsWith(tagPrefix)) throw new ReleaseError("TAG_INVALID", "Release tag does not match tag-prefix");
    version = tag.slice(tagPrefix.length);
  } else if (valid(tag) === tag) version = tag;
  else if (tag.startsWith("v") && valid(tag.slice(1)) === tag.slice(1)) version = tag.slice(1);
  else {
    const parsed = parseVersionedTag(tag);
    if (!parsed || !parsed.prefix || /[0-9.]$/.test(parsed.prefix)) throw new ReleaseError("TAG_INVALID", "Release tag must end in exact SemVer; numeric prefixes require tag-prefix");
    version = parsed.version.version;
  }
  if (valid(version) !== version || version.includes("+") || (stableOnly && prerelease(version) !== null)) throw new ReleaseError("TAG_INVALID", "Release tag must be exact stable SemVer unless allow-prerelease is true");
  const remote = snapshot(git, { schema: 1, branch, tagPrefix: "v", initialVersion: "0.1.0", bump: "auto", latest: "automatic" });
  const entry = remote.tags.find((entry) => entry.tag === tag);
  if (!entry) throw new ReleaseError("TAG_NOT_FOUND", "Release tag must exist on origin");
  if (expectedCommit && entry.commit !== expectedCommit) throw new ReleaseError("TAG_COMMIT_MISMATCH", "Release tag does not match expected commit");
  if (!git.isAncestor(entry.commit, remote.branch)) throw new ReleaseError("NOT_ON_BRANCH", "Release tag must belong to the configured branch");
  return { tag, version, commit: entry.commit };
}

export function resolveSeriesLatest(workspace: string, config: ReleaseConfig, tag: string, commit: string): "true" | "false" {
  const git = new GitRepository(workspace);
  const remote = snapshot(git, config);
  const eligible = seriesTags(config, remote.tags, remote.branch, (a, b) => git.isAncestor(a, b));
  const target = eligible.find((entry) => entry.tag === tag && entry.commit === commit);
  if (!target) throw new Error("Release tag is outside the current series");
  const version = tag.slice(config.tagPrefix.length);
  if (prerelease(version) !== null) return "false";
  return eligible.some((entry) => {
    const candidate = entry.tag.slice(config.tagPrefix.length);
    return prerelease(candidate) === null && compare(candidate, version) > 0;
  }) ? "false" : "true";
}

export function bindReleaseTag(workspace: string, tag: string, commit: string, branch = "main"): { tag: string; version: string; commit: string; state: "created" | "existing" } {
  const git = new GitRepository(workspace);
  if (tag.startsWith("refs/tags/") || git.run(["check-ref-format", `refs/tags/${tag}`], { allowFailure: true }).status !== 0) throw new ReleaseError("TAG_INVALID", "Tag must be an exact Git ref name");
  const parsed = parseVersionedTag(tag);
  if (!parsed || parsed.version.build.length) throw new ReleaseError("TAG_INVALID", "Tag must end in exact SemVer without build metadata");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new ReleaseError("INVALID_INPUT", "Tag commit must be a full lowercase 40-character SHA");
  const config: ReleaseConfig = { schema: 1, branch, tagPrefix: parsed.prefix, initialVersion: "0.1.0", bump: "auto", latest: "automatic" };
  const verify = () => {
    const remote = snapshot(git, config);
    if (!git.isAncestor(commit, remote.branch)) throw new ReleaseError("NOT_ON_BRANCH", "Tag commit is not on the configured origin branch");
    const existing = remote.tags.find((entry) => entry.tag === tag);
    if (existing && existing.commit !== commit) throw new ReleaseError("TAG_CONFLICT", "Existing release tag resolves to a different commit and will not be replaced", "present");
    return Boolean(existing);
  };
  if (verify()) return { tag, version: parsed.version.version, commit, state: "existing" };
  let rejected = false;
  try {
    const result = git.run(["push", "--atomic", "--no-follow-tags", "origin", `${commit}:refs/tags/${tag}`], { allowFailure: true });
    rejected = result.status !== 0 && /remote rejected|\[rejected\]|hook declined|permission denied|authentication failed/i.test(result.stderr ?? "");
  } catch {
    // Inspect the remote binding even if the response was lost.
  }
  let verified: boolean;
  try { verified = verify(); }
  catch (error) {
    if (error instanceof ReleaseError && ["TAG_CONFLICT", "NOT_ON_BRANCH"].includes(error.code)) throw error;
    throw new ReleaseError("REMOTE_UNCERTAIN", "Release tag push outcome could not be verified; retry the same binding after checking origin", "unknown");
  }
  if (!verified) throw new ReleaseError(rejected ? "REMOTE_REJECTED" : "REMOTE_UNCERTAIN", "Release tag push was not verified; retry the same binding after checking origin", rejected ? "unchanged" : "unknown");
  return { tag, version: parsed.version.version, commit, state: "created" };
}
