import { readFile, stat, realpath } from "node:fs/promises";
import { parseDocument, visit, isAlias } from "yaml";
import { validRange } from "semver";
import { checkedPath, publicPath, sourcePath, assertTargets } from "./paths.ts";
export interface Mapping { from: string; to: string }
export interface RequiredMapping extends Mapping { required: boolean }
export type ReleaseSelector =
  | { tags: string[]; onEmpty: "error" | "skip" }
  | { tagPrefix: string; range: string; includePrereleases: boolean; onEmpty: "error" | "skip" };
export interface ReleaseAliases { tag?: string; select?: "highest-stable"; files: Mapping[] }
export interface ReleaseSetConfig { schema: 2; releases: ReleaseSelector; files: RequiredMapping[]; aliases?: ReleaseAliases }
export type DistributionConfig = { schema: 1; files: Mapping[] } | ReleaseSetConfig;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid distribution config object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(k => !keys.includes(k))) throw new Error("Unknown distribution config field");
  return result;
}
function mappings(value: unknown, required = false, shorthand = true): RequiredMapping[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) throw new Error("Config needs 1..10000 file mappings");
  const result = value.map(item => {
    const entry = object(shorthand && typeof item === "string" ? {from:item,to:item} : item, required ? ["from", "to", "required"] : ["from", "to"]);
    if (typeof entry.from !== "string" || typeof entry.to !== "string") throw new Error("Config from/to must be strings");
    if (entry.required !== undefined && typeof entry.required !== "boolean") throw new Error("required must be boolean");
    const from = sourcePath(entry.from);
    if (required && (from.includes("/") || from === ".")) throw new Error("Release assets have flat names");
    return { from, to: publicPath(entry.to), required: entry.required !== false };
  });
  assertTargets(result.map(m => m.to));
  return result;
}
export function parseConfig(value: unknown): DistributionConfig {
  return parsePolicy(value, true);
}
// Reports keep their existing object-only, versioned policy contract.
export function parseReportPolicy(value: unknown): ReleaseSetConfig {
  const config = parsePolicy(value, false);
  if (config.schema !== 2) throw new Error("Release-set report needs schema: 2");
  return config;
}
function parsePolicy(value: unknown, shorthand: boolean): DistributionConfig {
  const config = object(value, ["schema", "files", "releases", "aliases"]);
  const schema = "schema" in config ? config.schema : shorthand ? ("releases" in config ? 2 : 1) : undefined;
  if (schema === 1) {
    object(value, ["schema", "files"]);
    return { schema: 1, files: mappings(config.files,false,shorthand).map(({from,to}) => ({from,to})) };
  }
  if (schema !== 2) throw new Error("Config schema must be 1 or 2 when provided");
  const raw = object(config.releases, ["tags", "tag-prefix", "range", "include-prereleases", "on-empty"]);
  const onEmpty = raw["on-empty"] ?? "error";
  if (onEmpty !== "error" && onEmpty !== "skip") throw new Error("on-empty must be error or skip");
  // Null is never an omitted value in the public config.
  if (raw["on-empty"] === null) throw new Error("on-empty must be error or skip");
  let releases: ReleaseSelector;
  if ("tags" in raw) {
    object(raw, ["tags", "on-empty"]);
    if (!Array.isArray(raw.tags) || !raw.tags.length || raw.tags.some(t => typeof t !== "string")) throw new Error("tags must be a nonempty string list");
    const tags = (raw.tags as string[]).map(publicPath);
    if (new Set(tags).size !== tags.length) throw new Error("Duplicate release tag");
    releases = { tags: tags.slice().sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b))), onEmpty };
  } else {
    if (typeof raw["tag-prefix"] !== "string" || typeof raw.range !== "string" || !raw.range.trim() || !validRange(raw.range)) throw new Error("Release range needs tag-prefix and a valid SemVer range");
    if (raw["include-prereleases"] !== undefined && typeof raw["include-prereleases"] !== "boolean") throw new Error("include-prereleases must be boolean");
    releases = { tagPrefix: raw["tag-prefix"], range: raw.range, includePrereleases: raw["include-prereleases"] === true, onEmpty };
  }
  const files = mappings(config.files,true,shorthand);
  if (!files.some(m => m.required)) throw new Error("At least one required file is needed");
  let aliases: ReleaseAliases | undefined;
  if (config.aliases !== undefined) {
    const a = object(config.aliases,["tag","select","files"]);
    if (("tag" in a) === ("select" in a)) throw new Error("Aliases need exactly one of tag or select");
    if ("tag" in a && typeof a.tag !== "string") throw new Error("Alias tag must be a string");
    if ("select" in a && (a.select !== "highest-stable" || "tags" in releases)) throw new Error("highest-stable aliases need a range selector");
    const aliasFiles = mappings(a.files,false,shorthand).map(({from,to}) => ({from:publicPath(from),to}));
    if (aliasFiles.some(m => !files.some(f => f.required && f.to === m.from))) throw new Error("Alias from must name a required mapped target");
    aliases = { ...(typeof a.tag === "string" ? {tag:publicPath(a.tag)} : {select:"highest-stable" as const}), files:aliasFiles };
  }
  return { schema:2, releases, files, ...(aliases ? {aliases} : {}) };
}
export async function readConfig(workspace: string, name: string): Promise<DistributionConfig> {
  const file = await checkedPath(await realpath(workspace), sourcePath(name));
  if ((await stat(file)).size > 256 * 1024) throw new Error("Config exceeds 256 KiB");
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Config exceeds 256 KiB");
  let value: unknown;
  try {
    const doc = parseDocument(text, { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    visit(doc, (_key, node, path) => {
      if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && node.anchor) || path.length > 16) throw new Error();
    });
    value = doc.toJS({ maxAliasCount: 0 });
  } catch { throw new Error("Invalid strict YAML/JSON config (duplicate keys, aliases, anchors and deep nesting are forbidden)"); }
  return parseConfig(value);
}
