import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, posix } from "node:path";

export function portableKey(path: string): string { return path.normalize("NFC").toUpperCase().toLowerCase(); }
export function publicPath(path: string): string {
  if (!path || path.startsWith("/") || /[\\\x00-\x1f\x7f<>:"|?*]/u.test(path)) throw new Error("Invalid public path");
  for (const part of path.split("/")) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || portableKey(part) === ".git") {
      throw new Error("Invalid portable path segment");
    }
  }
  return path;
}
export function sourcePath(path: string): string {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\\\x00-\x1f\x7f]/u.test(path) ||
      path.split("/").some(p => p === ".." || p === "" || portableKey(p) === ".git")) throw new Error("Source must be a relative POSIX path");
  return path;
}
export function pattern(path: string): string {
  sourcePath(path);
  if (/[\[\]{}()!]/.test(path) || path.split("/").some(s => s.includes("**") && s !== "**")) {
    throw new Error("Patterns support only *, ? and **; use config for literal metacharacters");
  }
  return path;
}
export function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}
export async function checkedPath(root: string, rel: string): Promise<string> {
  sourcePath(rel);
  let cursor = root;
  for (const part of rel.split("/")) {
    if (part === ".") continue;
    cursor = resolve(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not supported");
  }
  const canonical = await realpath(cursor);
  if (!inside(root, canonical)) throw new Error("Source escapes its root");
  return canonical;
}
export function commonRoot(prefixes: string[]): string {
  let parts = prefixes[0].split("/").filter(p => p && p !== ".");
  for (const prefix of prefixes.slice(1)) {
    const next = prefix.split("/").filter(p => p && p !== ".");
    parts = parts.slice(0, parts.findIndex((p, i) => p !== next[i]) < 0 ? parts.length : parts.findIndex((p, i) => p !== next[i]));
  }
  return parts.join("/") || ".";
}
export function prefix(path: string, directory: boolean): string {
  const i = path.search(/[*?]/);
  return i < 0 ? (directory ? path : posix.dirname(path)) : posix.dirname(path.slice(0, i) + "_");
}
export function visible(path: string, request: string): boolean {
  const explicit = new Set(request.split("/").filter(p => p.startsWith(".") && p !== "."));
  return path.split("/").every(p => !p.startsWith(".") || p === "." || explicit.has(p));
}
export function assertTargets(paths: string[]): void {
  const all = new Set<string>();
  for (const path of paths) {
    publicPath(path);
    const key = portableKey(path);
    if (all.has(key)) throw new Error("Duplicate public target");
    all.add(key);
  }
  for (const key of all) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (all.has(parts.slice(0, i).join("/"))) throw new Error("File and directory target conflict");
    }
  }
}
