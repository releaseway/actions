import { lstat, readdir, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { assertTargets, checkedPath } from "./paths.ts";
import type { Selection } from "./local.ts";
export async function selectSite(workspace: string, name: string, deadline: number): Promise<{root:string; selections:Selection[]}> {
  const requested = resolve(workspace, name);
  if ((await lstat(requested)).isSymbolicLink()) throw new Error("site cannot be a symbolic link");
  const root = await realpath(requested), selections: Selection[] = [];
  let count = 0;
  async function walk(rel: string) {
    if (Date.now() > deadline || ++count > 100_000) throw new Error("Site exceeds traversal count or deadline");
    const path = await checkedPath(root,rel), st = await lstat(path);
    if (st.isDirectory()) for (const child of (await readdir(path)).sort()) await walk(posix.join(rel,child));
    else if (st.isFile()) selections.push({ source:path,from:rel,to:rel });
    else throw new Error("Site contains a non-regular file");
  }
  if (!(await lstat(root)).isDirectory()) throw new Error("site must be a directory");
  await walk(".");
  assertTargets(selections.map(s=>s.to));
  return {root,selections};
}
