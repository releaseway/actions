import { readFile, stat, realpath } from "node:fs/promises";
import { parseDocument, visit, isAlias, isPair, isScalar, isNode, LineCounter } from "yaml";
import { validRange } from "semver";
import { checkedPath, publicPath, sourcePath, assertTargets, portableKey } from "./paths.ts";
import { ConfigError, invalid, atPath, configPath, fileError, quoted, type ConfigPath } from "./config-errors.ts";
export interface Mapping { from: string; to: string }
export interface RequiredMapping extends Mapping { required: boolean }
export type ReleaseSelector =
  | { tags: string[]; onEmpty: "error" | "skip" }
  | { tagPrefix: string; range: string; includePrereleases: boolean; onEmpty: "error" | "skip" };
export interface ReleaseAliases { tag?: string; select?: "highest-stable"; files: Mapping[] }
export interface ReleaseSetConfig { schema: 2; releases: ReleaseSelector; files: RequiredMapping[]; aliases?: ReleaseAliases }
export type DistributionConfig = { schema: 1; files: Mapping[] } | ReleaseSetConfig;
function object(value: unknown, keys: string[], path: ConfigPath = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path,"Expected a distribution config object");
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).find(k => !keys.includes(k));
  if (unknown !== undefined) invalid([...path,unknown],`Unknown key ${quoted(unknown)}. Allowed keys: ${keys.join(", ")}`);
  return result;
}
function mappings(value: unknown, required = false, shorthand = true, path: ConfigPath = ["files"]): RequiredMapping[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) invalid(path,"Config needs 1..10000 file mappings");
  const result = value.map((item,index) => {
    const location = [...path,index];
    const string = shorthand && typeof item === "string";
    const entry = object(string ? {from:item,to:item} : item, required ? ["from", "to", "required"] : ["from", "to"],location);
    if (typeof entry.from !== "string") invalid([...location,"from"],"from must be a string");
    if (typeof entry.to !== "string") invalid([...location,"to"],"to must be a string");
    if (entry.required !== undefined && typeof entry.required !== "boolean") invalid([...location,"required"],"required must be boolean");
    const fromPath = string ? location : [...location,"from"];
    const from = atPath(fromPath,() => sourcePath(entry.from as string));
    if (required && (from.includes("/") || from === ".")) invalid(fromPath,"Release assets have flat names");
    return { from, to: atPath(string ? location : [...location,"to"],() => publicPath(entry.to as string)), required: entry.required !== false };
  });
  try { assertTargets(result.map(m => m.to)); }
  catch {
    const seen = new Map<string,number>();
    for (const [index,mapping] of result.entries()) {
      const key = portableKey(mapping.to);
      if (seen.has(key)) invalid([...path,index],`Duplicate public target; conflicts with ${configPath([...path,seen.get(key)!])}`);
      seen.set(key,index);
    }
    for (const [key,index] of seen) {
      const parts = key.split("/");
      for (let n=1;n<parts.length;n++) {
        const other = seen.get(parts.slice(0,n).join("/"));
        if (other !== undefined) invalid([...path,index],`File and directory target conflict with ${configPath([...path,other])}`);
      }
    }
    invalid(path,"Invalid public target");
  }
  return result;
}
export function parseConfig(value: unknown): DistributionConfig {
  return parsePolicy(value, true);
}
// Reports keep their existing object-only, versioned policy contract.
export function parseReportPolicy(value: unknown): ReleaseSetConfig {
  const config = parsePolicy(value, false);
  if (config.schema !== 2) invalid(["schema"],"Release-set report needs schema: 2");
  return config;
}
function parsePolicy(value: unknown, shorthand: boolean): DistributionConfig {
  const config = object(value, ["schema", "files", "releases", "aliases"]);
  const schema = "schema" in config ? config.schema : shorthand ? ("releases" in config ? 2 : 1) : undefined;
  if (schema === 1) {
    object(value, ["schema", "files"]);
    return { schema: 1, files: mappings(config.files,false,shorthand).map(({from,to}) => ({from,to})) };
  }
  if (schema !== 2) invalid(["schema"],"Config schema must be 1 or 2 when provided");
  const raw = object(config.releases, ["tags", "tag-prefix", "range", "include-prereleases", "on-empty"],["releases"]);
  const onEmpty = raw["on-empty"] ?? "error";
  if (onEmpty !== "error" && onEmpty !== "skip") invalid(["releases","on-empty"],"on-empty must be error or skip");
  // Null is never an omitted value in the public config.
  if (raw["on-empty"] === null) invalid(["releases","on-empty"],"on-empty must be error or skip");
  let releases: ReleaseSelector;
  if ("tags" in raw) {
    object(raw, ["tags", "on-empty"],["releases"]);
    if (!Array.isArray(raw.tags) || !raw.tags.length || raw.tags.some(t => typeof t !== "string")) invalid(["releases","tags"],"tags must be a nonempty string list");
    const tags = (raw.tags as string[]).map((tag,index) => atPath(["releases","tags",index],() => publicPath(tag)));
    if (new Set(tags).size !== tags.length) invalid(["releases","tags"],"Duplicate release tag");
    releases = { tags: tags.slice().sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b))), onEmpty };
  } else {
    if (typeof raw["tag-prefix"] !== "string") invalid(["releases","tag-prefix"],"Release range needs a string tag-prefix");
    if (typeof raw.range !== "string" || !raw.range.trim() || !validRange(raw.range)) invalid(["releases","range"],"Release range needs a valid SemVer range");
    if (raw["include-prereleases"] !== undefined && typeof raw["include-prereleases"] !== "boolean") invalid(["releases","include-prereleases"],"include-prereleases must be boolean");
    releases = { tagPrefix: raw["tag-prefix"], range: raw.range, includePrereleases: raw["include-prereleases"] === true, onEmpty };
  }
  const files = mappings(config.files,true,shorthand);
  if (!files.some(m => m.required)) invalid(["files"],"At least one required file is needed");
  let aliases: ReleaseAliases | undefined;
  if (config.aliases !== undefined) {
    const a = object(config.aliases,["tag","select","files"],["aliases"]);
    if (("tag" in a) === ("select" in a)) invalid(["aliases"],"Aliases need exactly one of tag or select");
    if ("tag" in a && typeof a.tag !== "string") invalid(["aliases","tag"],"Alias tag must be a string");
    if ("select" in a && (a.select !== "highest-stable" || "tags" in releases)) invalid(["aliases","select"],"highest-stable aliases need a range selector");
    const aliasFiles = mappings(a.files,false,shorthand,["aliases","files"]).map(({from,to},index) => ({from:atPath(["aliases","files",index],() => publicPath(from)),to}));
    const missing = aliasFiles.findIndex(m => !files.some(f => f.required && f.to === m.from));
    if (missing !== -1) invalid(["aliases","files",missing],"Alias from must name a required mapped target");
    aliases = { ...(typeof a.tag === "string" ? {tag:atPath(["aliases","tag"],() => publicPath(a.tag as string))} : {select:"highest-stable" as const}), files:aliasFiles };
  }
  return { schema:2, releases, files, ...(aliases ? {aliases} : {}) };
}
export async function readConfig(workspace: string, name: string): Promise<DistributionConfig> {
  const file = await checkedPath(await realpath(workspace), sourcePath(name));
  if ((await stat(file)).size > 256 * 1024) throw new Error("Config exceeds 256 KiB");
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Config exceeds 256 KiB");
  const lines = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false, lineCounter: lines });
  const syntax = doc.errors[0] ?? doc.warnings[0];
  if (syntax) {
    const position = lines.linePos(syntax.pos[0]);
    throw new Error(`${quoted(name)}:${position.line}:${position.col}: Invalid strict YAML/JSON config (${syntax.code})`);
  }
  try {
    visit(doc, (_key, node, path) => {
      if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && node.anchor) || path.length > 16 ||
          (isPair(node) && (!isScalar(node.key) || typeof node.key.value !== "string" || node.key.value === "<<"))) {
        const point = isPair(node) ? node.key : node;
        const offset = isNode(point) ? point.range?.[0] ?? 0 : 0;
        const position = lines.linePos(offset);
        throw new Error(`${quoted(name)}:${position.line}:${position.col}: Invalid strict YAML/JSON config (anchors, aliases, merge keys, non-string keys and deep nesting are forbidden)`);
      }
    });
    return parseConfig(doc.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    if (error instanceof ConfigError) throw fileError(error,name,doc,lines);
    throw error;
  }
}
