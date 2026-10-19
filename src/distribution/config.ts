import { readFile, stat, realpath } from "node:fs/promises";
import { parseDocument, visit, isAlias } from "yaml";
import { checkedPath, publicPath, sourcePath, assertTargets } from "./paths.ts";
export interface Mapping { from: string; to: string }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid distribution config object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(k => !keys.includes(k))) throw new Error("Unknown distribution config field");
  return result;
}
export async function readConfig(workspace: string, name: string): Promise<Mapping[]> {
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
  const config = object(value, ["schema", "files"]);
  if (config.schema !== 1 || !Array.isArray(config.files) || config.files.length < 1 || config.files.length > 10_000) throw new Error("Config needs schema: 1 and 1..10000 file mappings");
  const mappings = config.files.map(item => {
    const entry = object(item, ["from", "to"]);
    if (typeof entry.from !== "string" || typeof entry.to !== "string") throw new Error("Config from/to must be strings");
    return { from: sourcePath(entry.from), to: publicPath(entry.to) };
  });
  assertTargets(mappings.map(m => m.to));
  return mappings;
}
