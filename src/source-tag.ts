import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { valid, prerelease, compare } from "semver";
import planSchema from "../contracts/source-plan-v2.schema.json" with { type: "json" };
import tagSchema from "../contracts/source-tag-v1.schema.json" with { type: "json" };
import { GitRepository } from "./git.ts";
import type { ReleaseConfig } from "./release-config.ts";
import { snapshot, latestPolicy } from "./release-execution.ts";
import { nextSeriesVersion, seriesTags } from "./series.ts";
import { matchesSchema, parseReleaseJson } from "./release-json.ts";
import { ReleaseError } from "./release-error.ts";

type SourceConfig = Omit<ReleaseConfig, "strategy" | "series"> & { strategy: "source-tag"; series: NonNullable<ReleaseConfig["series"]> | null };
export interface SourceReleasePlan {
  schema: 2;
  strategy: "source-tag";
  config: SourceConfig;
  policyDigest: string;
  source: string;
  commit: string;
  tag: string;
  version: string;
  prereleaseId: string;
  latest: "automatic" | "true" | "false";
  state: "planned" | "existing";
  tagObject: string;
}
const marker = "Releaseway-Source-Tag: 1\n\n";
export function sourceConfig(config: ReleaseConfig | SourceConfig): SourceConfig {
  return { schema: 1, strategy: "source-tag", branch: config.branch, tagPrefix: config.tagPrefix, initialVersion: config.initialVersion, bump: config.bump, series: config.series ? { baseTag: config.series.baseTag, startVersion: config.series.startVersion } : null, latest: config.latest };
}
const hashPolicy = (config: SourceConfig) => createHash("sha256").update(JSON.stringify(sourceConfig(config))).digest("hex");
const executionConfig = (config: SourceConfig): ReleaseConfig => ({ ...config, series: config.series ?? undefined });
const namespace = (config: SourceConfig) => JSON.stringify([config.branch, config.tagPrefix, config.series]);
function tagPayload(git: GitRepository, plan: Omit<SourceReleasePlan, "tagObject" | "state">): string {
  const config = sourceConfig(plan.config);
  const annotation = { schema: 1, strategy: "source-tag", source: plan.source, config, policyDigest: plan.policyDigest, prereleaseId: plan.prereleaseId, tag: plan.tag, version: plan.version };
  const timestamp = Number(git.run(["show", "-s", "--format=%ct", plan.source]).stdout.trim()) + 1;
  const message = `${marker}${JSON.stringify(annotation)}\n`;
  if (Buffer.byteLength(message) > 256 * 1024) throw new ReleaseError("CONFIG_INVALID", "Source-tag annotation exceeds 256 KiB");
  return `object ${plan.source}\ntype commit\ntag ${plan.tag}\ntagger github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com> ${timestamp} +0000\n\n${message}`;
}
function objectId(payload: string): string {
  const bytes = Buffer.from(payload);
  return createHash("sha1").update(`tag ${bytes.length}\0`).update(bytes).digest("hex");
}
function validateIdentity(git: GitRepository, plan: SourceReleasePlan): void {
  git.run(["check-ref-format", `refs/heads/${plan.config.branch}`]);
  git.run(["check-ref-format", `refs/tags/${plan.config.tagPrefix}0.0.0`]);
  git.run(["check-ref-format", `refs/tags/${plan.tag}`]);
  if (plan.config.series) git.run(["check-ref-format", `refs/tags/${plan.config.series.baseTag}`]);
  if (plan.source !== plan.commit || plan.tag !== plan.config.tagPrefix + plan.version || valid(plan.version) !== plan.version || (prerelease(plan.version)?.[0] ?? "") !== plan.prereleaseId || hashPolicy(plan.config) !== plan.policyDigest || latestPolicy(executionConfig(plan.config), plan.version) !== plan.latest || objectId(tagPayload(git, plan)) !== plan.tagObject) {
    throw new ReleaseError("PLAN_INVALID", "Source-tag plan identity does not match its canonical configuration and tag object");
  }
}
export function validateSourcePlan(git: GitRepository, value: unknown): SourceReleasePlan {
  if (!matchesSchema(planSchema, value)) throw new ReleaseError("PLAN_INVALID", "Invalid source-tag plan schema");
  const plan = value as SourceReleasePlan;
  try { validateIdentity(git, plan); } catch (error) {
    if (error instanceof ReleaseError && error.code === "PLAN_INVALID") throw error;
    throw new ReleaseError("PLAN_INVALID", "Source-tag plan refers to invalid source or policy data");
  }
  return plan;
}
function identities(git: GitRepository, remote: ReturnType<typeof snapshot>, config: SourceConfig, source: string): SourceReleasePlan[] {
  const found: SourceReleasePlan[] = [];
  for (const entry of remote.tags) {
    if (entry.commit !== source || !entry.tag.startsWith(config.tagPrefix)) continue;
    const ref = `refs/releaseway/tags/${entry.tag}`;
    if (git.run(["cat-file", "-t", ref]).stdout.trim() !== "tag") continue;
    const raw = git.run(["cat-file", "tag", ref]).stdout;
    const message = raw.slice(raw.indexOf("\n\n") + 2);
    if (!message.startsWith("Releaseway-Source-Tag:")) continue;
    try {
      if (!message.startsWith(marker)) throw new Error("Unknown source-tag annotation schema");
      const value = parseReleaseJson(Buffer.from(message.slice(marker.length)));
      if (!matchesSchema(tagSchema, value)) throw new Error("Invalid source-tag annotation");
      const annotation = value as { source: string; config: SourceConfig; policyDigest: string; prereleaseId: string; tag: string; version: string };
      if (namespace(sourceConfig(annotation.config)) !== namespace(config)) continue;
      const plan: SourceReleasePlan = { schema: 2, strategy: "source-tag", config: sourceConfig(annotation.config), policyDigest: annotation.policyDigest, source: annotation.source, commit: annotation.source, tag: annotation.tag, version: annotation.version, prereleaseId: annotation.prereleaseId, latest: latestPolicy(executionConfig(annotation.config), annotation.version), state: "existing", tagObject: objectId(raw) };
      validateIdentity(git, plan);
      if (plan.source !== entry.commit || plan.tag !== entry.tag || raw !== tagPayload(git, plan)) throw new Error("Remote source-tag object differs from its annotation");
      found.push(plan);
    } catch {
      throw new ReleaseError("IDENTITY_CONFLICT", `Invalid reserved source-tag identity: ${entry.tag}`, "present");
    }
  }
  return found;
}
export function planSourceRelease(workspace: string, config: ReleaseConfig, prereleaseId = "", explicitSource?: string, resumeExisting = false): SourceReleasePlan {
  const git = new GitRepository(workspace);
  if (git.run(["status", "--porcelain", "--untracked-files=no"]).stdout.trim()) throw new ReleaseError("INVALID_INPUT", "Release planning requires clean tracked source files");
  if (prereleaseId && !/^[A-Za-z][A-Za-z0-9-]*$/.test(prereleaseId)) throw new ReleaseError("INVALID_INPUT", "prerelease-id must be a single nonnumeric SemVer identifier");
  const remote = snapshot(git, config);
  const source = explicitSource ?? git.resolveCommit("HEAD");
  if (!/^[0-9a-f]{40}$/.test(source)) throw new ReleaseError("INVALID_INPUT", "Release source must be a full lowercase commit SHA");
  const normalized = sourceConfig(config);
  const records = identities(git, remote, normalized, source);
  const same = records.filter((plan) => plan.prereleaseId === prereleaseId);
  if (same.length > 1 || same.some((plan) => plan.policyDigest !== hashPolicy(normalized))) throw new ReleaseError("IDENTITY_CONFLICT", "Conflicting source-tag policies or multiple releases for the same source and channel", "present");
  const closed = Boolean(prereleaseId && records.some((plan) => plan.prereleaseId === ""));
  if (closed && !(resumeExisting && same.length === 1)) throw new ReleaseError("CHANNEL_CLOSED", "Stable release already exists for this source; resolve or resume the existing prerelease explicitly", "present");
  if (same.length) {
    if (!git.isAncestor(source, remote.branch)) throw new ReleaseError("NOT_ON_BRANCH", "Existing release source is not on the configured origin branch", "present");
    return same[0]!;
  }
  if (remote.branch !== source) throw new ReleaseError("PLAN_STALE", "Origin branch differs from the release source; refresh checkout before planning");
  const eligible = seriesTags(config, remote.tags, source, (a, b) => git.isAncestor(a, b));
  eligible.sort((a, b) => compare(a.tag.slice(config.tagPrefix.length), b.tag.slice(config.tagPrefix.length)));
  const base = eligible.at(-1)?.commit ?? (config.series ? remote.tags.find((entry) => entry.tag === config.series!.baseTag)!.commit : null);
  const messages = git.run(["log", "--format=%B%x00", ...(base ? [`${base}..${source}`] : [source])]).stdout.split("\0").filter((message) => message.trim()).map((message) => message.trim());
  const version = nextSeriesVersion(config, eligible, messages, prereleaseId);
  const plan: SourceReleasePlan = { schema: 2, strategy: "source-tag", config: normalized, policyDigest: hashPolicy(normalized), source, commit: source, tag: config.tagPrefix + version, version, prereleaseId, latest: latestPolicy(config, version), state: "planned", tagObject: "" };
  git.run(["check-ref-format", `refs/tags/${plan.tag}`]);
  plan.tagObject = objectId(tagPayload(git, plan));
  if (remote.tags.some((tag) => tag.tag === plan.tag)) throw new ReleaseError("TAG_CONFLICT", `Release tag already exists and will not be replaced: ${plan.tag}`, "present");
  return plan;
}
export function executeSourcePlan(workspace: string, value: unknown, config: ReleaseConfig): SourceReleasePlan {
  const git = new GitRepository(workspace);
  const plan = validateSourcePlan(git, value);
  if (config.strategy !== "source-tag" || hashPolicy(sourceConfig(config)) !== plan.policyDigest) throw new ReleaseError("PLAN_CONFIG_MISMATCH", "Release plan configuration changed; create a fresh plan");
  if (git.resolveCommit("HEAD") !== plan.source) throw new ReleaseError("PLAN_STALE", "Saved source-tag plan requires checkout of its source");
  const before = snapshot(git, config);
  const existing = before.tags.find((tag) => tag.tag === plan.tag);
  if (existing && (existing.commit !== plan.source || git.run(["rev-parse", `refs/releaseway/tags/${plan.tag}`]).stdout.trim() !== plan.tagObject)) throw new ReleaseError("TAG_CONFLICT", "Existing tag has a different source or tag object and will not be replaced", "present");
  const fresh = planSourceRelease(workspace, config, plan.prereleaseId, plan.source, true);
  for (const key of ["source", "commit", "tag", "version", "latest", "tagObject"] as const) {
    if (fresh[key] !== plan[key]) throw new ReleaseError("PLAN_STALE", `Release plan ${key} changed; create a fresh plan`);
  }
  if (fresh.state === "existing") return fresh;
  const payload = tagPayload(git, fresh);
  const object = spawnSync("git", ["-C", workspace, "hash-object", "-w", "-t", "tag", "--stdin"], { input: payload, encoding: "utf8", timeout: 30_000 });
  if (object.status !== 0 || object.stdout.trim() !== fresh.tagObject) throw new ReleaseError("INTERNAL_ERROR", "Could not create deterministic tag object");
  let rejected = false;
  try {
    const pushed = git.run(["push", "--no-follow-tags", "origin", `${fresh.tagObject}:refs/tags/${fresh.tag}`], { allowFailure: true });
    rejected = pushed.status !== 0 && /remote rejected|\[rejected\]|hook declined|permission denied|authentication failed/i.test(pushed.stderr ?? "");
  } catch {
    // A timeout can follow an accepted write. Always inspect origin before deciding.
  }
  let after: ReturnType<typeof snapshot>;
  try { after = snapshot(git, config); } catch { throw new ReleaseError("REMOTE_UNCERTAIN", "Tag push outcome could not be verified; inspect origin and resume the same plan", "unknown"); }
  const bound = after.tags.find((tag) => tag.tag === fresh.tag);
  if (bound) {
    if (bound.commit !== fresh.source || git.run(["rev-parse", `refs/releaseway/tags/${fresh.tag}`]).stdout.trim() !== fresh.tagObject) throw new ReleaseError("TAG_CONFLICT", "Concurrent tag binding differs from the saved plan", "present");
    const same = identities(git, after, fresh.config, fresh.source).filter((record) => record.prereleaseId === fresh.prereleaseId);
    if (same.length !== 1 || same[0]!.tagObject !== fresh.tagObject || same[0]!.policyDigest !== fresh.policyDigest) throw new ReleaseError("IDENTITY_CONFLICT", "Concurrent releases conflict for the same source and channel; existing tags are retained", "present");
    if (!git.isAncestor(fresh.source, after.branch)) throw new ReleaseError("NOT_ON_BRANCH", "Prepared source is no longer on the configured branch", "present");
    if (after.branch !== fresh.source) throw new ReleaseError("PLAN_STALE", "Origin branch moved while creating the tag; existing tag is retained", "present");
    return { ...fresh, state: "existing" };
  }
  throw new ReleaseError(rejected ? "REMOTE_REJECTED" : "REMOTE_UNCERTAIN", "Tag push was not verified; inspect origin and resume the same plan", rejected ? "unchanged" : "unknown");
}
