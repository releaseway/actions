import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep, isAbsolute } from "node:path";
import { parseDocument } from "yaml";
import { valid, prerelease } from "semver";

export interface ReleaseConfig {
  schema: 1;
  branch: string;
  tagPrefix: string;
  initialVersion: string;
  bump: "auto" | "patch" | "minor" | "major";
  series?: { baseTag: string; startVersion: string };
  latest: "automatic" | "current-series" | "true" | "false";
}

function mapping(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`${label}.${key} is not supported`);
  return object;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || /[\s\x00-\x1f]/.test(value)) throw new Error(`${label} must be a non-empty whitespace-free string`);
  return value;
}

function stable(value: unknown, label: string): string {
  const version = text(value, label);
  if (valid(version) !== version || prerelease(version) !== null || version.includes("+")) throw new Error(`${label} must be exact stable SemVer without build metadata`);
  return version;
}

export function parseReleaseConfig(source: string): ReleaseConfig {
  if (Buffer.byteLength(source) > 256 * 1024) throw new Error("release config exceeds 256 KiB");
  const document = parseDocument(source, { uniqueKeys: true, schema: "core" });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  const root = mapping(document.toJS({ maxAliasCount: 0 }), ["schema", "branch", "tag-prefix", "initial-version", "bump", "series", "latest"], "release");
  if (root.schema !== 1) throw new Error("release.schema must be 1");
  const bump = root.bump ?? "auto";
  if (typeof bump !== "string" || !["auto", "patch", "minor", "major"].includes(bump)) throw new Error("release.bump must be auto, patch, minor, or major");
  const latest = root.latest ?? "automatic";
  if (typeof latest !== "string" || !["automatic", "current-series", "true", "false"].includes(latest)) throw new Error("release.latest must be automatic, current-series, or a quoted true/false string");
  let series: ReleaseConfig["series"];
  if (root.series !== undefined) {
    const value = mapping(root.series, ["base-tag", "start-version"], "release.series");
    series = { baseTag: text(value["base-tag"], "release.series.base-tag"), startVersion: stable(value["start-version"], "release.series.start-version") };
  }
  return {
    schema: 1,
    branch: text(root.branch ?? "main", "release.branch"),
    tagPrefix: root["tag-prefix"] === "" ? "" : text(root["tag-prefix"] ?? "v", "release.tag-prefix"),
    initialVersion: stable(root["initial-version"] ?? "0.1.0", "release.initial-version"),
    bump: bump as ReleaseConfig["bump"],
    latest: latest as ReleaseConfig["latest"],
    ...(series ? { series } : {}),
  };
}

export function readReleaseConfig(workspace: string, path = ".github/releaseway.yml"): ReleaseConfig {
  const root = realpathSync(workspace);
  const file = realpathSync(resolve(root, path));
  const diff = relative(root, file);
  if (isAbsolute(diff) || diff === ".." || diff.startsWith(".." + sep)) throw new Error("release config must resolve within the workspace");
  return parseReleaseConfig(readFileSync(file, "utf8"));
}
