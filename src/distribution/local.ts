import { glob, lstat, readdir, realpath } from "node:fs/promises";
import { resolve, posix, sep } from "node:path";
import { checkedPath, commonRoot, pattern, prefix, visible, assertTargets } from "./paths.ts";
import type { Mapping } from "./config.ts";
import type { Options } from "./inputs.ts";
export interface Selection { source: string; from: string; to: string; mode?: number; releaseId?: number; assetId?: number; aliasOf?: string }
export async function selectLocal(o: Options, deadline = Date.now() + 600_000, mappings?: Mapping[]): Promise<{ root: string; selections: Selection[] }> {
  const requestedRoot = resolve(o.workspace, o.root || ".");
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error("Root cannot be a symbolic link");
  const root = await realpath(requestedRoot);
  if (!(await lstat(root)).isDirectory()) throw new Error("root must be a directory");
  if (mappings) {
    const selections: Selection[] = [];
    for (const m of mappings) {
      const source = await checkedPath(root,m.from);
      if (!(await lstat(source)).isFile()) throw new Error("Config from must name an exact regular file");
      selections.push({source,from:m.from,to:m.to});
    }
    assertTargets(selections.map(s=>s.to));
    return {root,selections};
  }
  const selected = new Map<string, string>();
  const prefixes: string[] = [];
  let visited = 0;
  const walked = new Set<string>();
  function budget() { if (Date.now() > deadline) throw new Error("Distribution exceeded its deadline"); if (++visited > 100_000) throw new Error("Source traversal exceeds 100000 entries"); }
  async function walk(rel: string, request: string) {
    const key = request + "\0" + rel;
    if (walked.has(key)) return;
    walked.add(key);
    budget();
    if (!visible(rel, request)) return;
    const path = await checkedPath(root, rel);
    const st = await lstat(path);
    if (st.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(posix.join(rel, name), request);
    } else if (st.isFile()) {
      selected.set(rel, path);
      if (selected.size > 10_000) throw new Error("Selection exceeds 10000 files");
    } else throw new Error("Only regular files are supported");
  }
  for (const request of o.files) {
    pattern(request);
    const exact = !/[*?]/.test(request);
    const st = exact ? await lstat(await checkedPath(root, request)) : undefined;
    prefixes.push(prefix(request, st?.isDirectory() ?? false));
    let matched = false;
    for await (const nativeRel of glob(request, { cwd: root, exclude: path => { budget(); return !visible(path.split(sep).join("/"), request); } })) {
      const rel = nativeRel.split(sep).join("/");
      if (!visible(rel, request)) continue;
      matched = true;
      await walk(rel, request);
    }
    if (!matched) throw new Error("A files pattern matched no files");
  }
  if (!selected.size) throw new Error("Selection contains no regular files");
  const publicRoot = o.root ? "." : commonRoot(prefixes);
  const selections = [...selected].map(([from, source]) => ({ source, from, to: posix.relative(publicRoot, from) }));
  assertTargets(selections.map(s => s.to));
  return { root, selections };
}
