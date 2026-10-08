import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { valid, prerelease, compare } from "semver";
import { GitRepository } from "./git.ts";
import type { ReleaseConfig } from "./release-config.ts";
import { nextSeriesVersion, seriesTags, type SeriesTag } from "./series.ts";
import { parseVersionedTag } from "./range.ts";

export interface ReleasePlan {
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

const digest = (config: ReleaseConfig) => createHash("sha256").update(JSON.stringify(config)).digest("hex");

function validateRefs(git: GitRepository, config: ReleaseConfig): void {
  git.run(["check-ref-format", `refs/heads/${config.branch}`]);
  git.run(["check-ref-format", `refs/tags/${config.tagPrefix}0.0.0`]);
  if (config.series) git.run(["check-ref-format", `refs/tags/${config.series.baseTag}`]);
}

function snapshot(git: GitRepository, config: ReleaseConfig): { branch: string; tags: SeriesTag[] } {
  validateRefs(git, config);
  const refs = git.run(["ls-remote", "origin", `refs/heads/${config.branch}`, "refs/tags/*"]).stdout;
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
  if (!branch) throw new Error(`Origin branch does not exist: ${config.branch}`);
  // Private evidence refs never overwrite user tags or branches.
  git.run(["fetch", "--no-tags", "origin", `+refs/heads/${config.branch}:refs/releaseway/branch`, "+refs/tags/*:refs/releaseway/tags/*"]);
  if (git.resolveCommit("refs/releaseway/branch") !== branch) throw new Error("Origin branch changed while reading release state; retry planning");
  const tags: SeriesTag[] = [];
  for (const [tag, entry] of entries) {
    const commit = entry.peeled ?? entry.direct!;
    if (git.resolveCommit(`refs/releaseway/tags/${tag}`) !== commit) throw new Error(`Origin tag changed while reading release state: ${tag}`);
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

function latestPolicy(config: ReleaseConfig, version: string): ReleasePlan["latest"] {
  if (config.latest === "current-series") return prerelease(version) === null ? "true" : "false";
  if (config.latest === "true" && prerelease(version) !== null) throw new Error("Prerelease cannot be marked latest");
  return config.latest;
}

export function planRelease(workspace: string, config: ReleaseConfig, prereleaseId = "", explicitSource?: string): ReleasePlan {
  const git = new GitRepository(workspace);
  if (git.run(["status", "--porcelain", "--untracked-files=no"]).stdout.trim()) throw new Error("Release planning requires clean tracked source files");
  const remote = snapshot(git, config);
  const head = explicitSource ?? git.resolveCommit("HEAD");
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Release source must be a full commit SHA");
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
    if ((prerelease(version)?.[0] ?? "") !== prereleaseId) throw new Error("Retry prerelease-id differs from the prepared release");
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
  if (existing && existing.commit !== commit) throw new Error(`Release tag already exists and will not be replaced: ${tag}`);
  if (!existing && remote.branch !== head) throw new Error("Origin branch differs from the release source; refresh checkout before planning");
  if (existing && !git.isAncestor(commit, remote.branch)) throw new Error("Matching release tag is not on the configured origin branch");
  return { schema: 1, config, source: head, commit, tag, version, prereleaseId, latest: latestPolicy(config, version), state: existing ? "existing" : "planned" };
}

export function saveReleasePlan(path: string, plan: ReleasePlan): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
}

export function readReleasePlan(path: string): ReleasePlan {
  return JSON.parse(readFileSync(path, "utf8")) as ReleasePlan;
}

export function executeReleasePlan(workspace: string, plan: ReleasePlan, config: ReleaseConfig): ReleasePlan {
  if (plan.schema !== 1 || JSON.stringify(plan.config) !== JSON.stringify(config)) throw new Error("Release plan configuration changed; create a fresh plan");
  const git = new GitRepository(workspace);
  const checkout = git.resolveCommit("HEAD");
  if (checkout !== plan.source && checkout !== plan.commit) throw new Error("Saved release plan requires checkout of its source or marker commit; unrelated source cannot be used to resume");
  const fresh = planRelease(workspace, config, plan.prereleaseId, plan.source);
  for (const key of ["source", "commit", "tag", "version", "latest"] as const) {
    if (fresh[key] !== plan[key]) throw new Error(`Release plan ${key} changed; create a fresh plan`);
  }
  if (fresh.state === "existing") return fresh;
  const result = git.run(["push", "--atomic", "--no-follow-tags", `--force-with-lease=refs/heads/${config.branch}:${plan.source}`, "origin", `${plan.commit}:refs/heads/${config.branch}`, `${plan.commit}:refs/tags/${plan.tag}`], { allowFailure: true });
  // A transport failure may occur after the atomic transaction was accepted.
  const remote = snapshot(git, config);
  const bound = remote.tags.find((tag) => tag.tag === plan.tag);
  if (bound?.commit === plan.commit && git.isAncestor(plan.commit, remote.branch)) return { ...fresh, state: "existing" };
  if (result.status !== 0) throw new Error(`Atomic release push failed; no refs are rolled back or overwritten. Resume using the saved plan after checking origin. ${result.stderr?.trim() ?? ""}`);
  throw new Error("Atomic release push returned success but its remote binding could not be verified; resume using the saved plan");
}

export function resolveReleaseTag(workspace: string, tag: string, branch = "main", stableOnly = true): { tag: string; version: string; commit: string } {
  const git = new GitRepository(workspace);
  git.run(["check-ref-format", `refs/tags/${tag}`]);
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (valid(version) !== version || version.includes("+") || (stableOnly && prerelease(version) !== null)) throw new Error("Release tag must be exact stable SemVer vX.Y.Z");
  const remote = snapshot(git, { schema: 1, branch, tagPrefix: "v", initialVersion: "0.1.0", bump: "auto", latest: "automatic" });
  const entry = remote.tags.find((entry) => entry.tag === tag);
  if (!entry || !git.isAncestor(entry.commit, remote.branch)) throw new Error("Release tag must exist on origin and belong to the configured branch");
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
  git.run(["check-ref-format", `refs/tags/${tag}`]);
  const parsed = parseVersionedTag(tag);
  if (!parsed || parsed.version.build.length) throw new Error("Tag must end in exact SemVer without build metadata");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Tag commit must be a full lowercase 40-character SHA");
  const config: ReleaseConfig = { schema: 1, branch, tagPrefix: parsed.prefix, initialVersion: "0.1.0", bump: "auto", latest: "automatic" };
  const verify = () => {
    const remote = snapshot(git, config);
    if (!git.isAncestor(commit, remote.branch)) throw new Error("Tag commit is not on the configured origin branch");
    const existing = remote.tags.find((entry) => entry.tag === tag);
    if (existing && existing.commit !== commit) throw new Error("Existing release tag resolves to a different commit and will not be replaced");
    return Boolean(existing);
  };
  if (verify()) return { tag, version: parsed.version.version, commit, state: "existing" };
  const result = git.run(["push", "--atomic", "--no-follow-tags", "origin", `${commit}:refs/tags/${tag}`], { allowFailure: true });
  if (!verify()) throw new Error(`Release tag push was not verified; retry the same binding. ${result.stderr ?? ""}`);
  return { tag, version: parsed.version.version, commit, state: "created" };
}
