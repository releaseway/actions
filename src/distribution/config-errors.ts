import { isMap, isScalar, type Document, type LineCounter } from "yaml";

export type ConfigPath = (string | number)[];
export function quoted(value: string): string {
  return JSON.stringify(value.length > 256 ? value.slice(0, 256) + "…" : value)
    .replace(/[\u007f\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,"0")}`);
}
export function configPath(path: ConfigPath): string {
  return path.reduce<string>((out, key) => typeof key === "number" ? `${out}[${key}]` :
    key.length <= 256 && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? `${out ? out + "." : ""}${key}` : `${out}[${quoted(key)}]`, "") || "$";
}
export class ConfigError extends Error {
  readonly path: ConfigPath;
  constructor(path: ConfigPath, message: string) {
    super(`${message} at ${configPath(path)}`);
    this.path = path;
  }
}
export function invalid(path: ConfigPath, message: string): never { throw new ConfigError(path,message); }
export function atPath<T>(path: ConfigPath, check: () => T): T {
  try { return check(); }
  catch (error) {
    if (error instanceof ConfigError) throw error;
    return invalid(path,error instanceof Error ? error.message : "Invalid config value");
  }
}
export function fileError(error: ConfigError, name: string, doc: Document, lines: LineCounter): Error {
  let path = error.path;
  let offset = 0;
  while (path.length) {
    const key = path.at(-1);
    const parent = doc.getIn(path.slice(0,-1),true);
    const node = isMap(parent) ? parent.items.find(pair => isScalar(pair.key) && pair.key.value === key)?.key : doc.getIn(path,true);
    if (node && typeof node === "object" && "range" in node && Array.isArray(node.range)) {
      offset = node.range[0]; break;
    }
    path = path.slice(0,-1);
  }
  const position = lines.linePos(offset);
  return new Error(`${quoted(name)}:${position.line}:${position.col}: ${error.message}`);
}
