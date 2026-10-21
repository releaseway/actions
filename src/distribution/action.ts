import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile, rename, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "./inputs.ts";
import { input, options } from "./inputs.ts";
import { selectLocal, type Selection } from "./local.ts";
import { inside, publicPath, assertTargets } from "./paths.ts";
import { copyFile, hashFile } from "./copy.ts";
import { contentDigest, ordered, reportShape, type FileRecord } from "./report.ts";
import { prepareRelease } from "./release.ts";
import type { ReleaseClient } from "./gh.ts";
import { readConfig } from "./config.ts";
import { selectSite } from "./site.ts";
import { prepareReleaseSet } from "./release-set.ts";
export async function distribute(env: Environment = process.env, client?: ReleaseClient, configWorkspace?: string) {
  const o = options(env), deadline = Date.now() + 600_000;
  const config = o.config ? await readConfig(configWorkspace ?? o.workspace,o.config) : undefined;
  const mappings = config?.schema === 1 ? config.files : undefined;
  const destination = input(env,"destination"); if (destination) publicPath(destination);
  const conflict = input(env,"conflict") || "error";
  if (!["error","replace"].includes(conflict)) throw new Error("conflict must be error or replace");
  if (config?.schema !== 2 && !input(env,"tag") && (input(env,"repository") || input(env,"commit") || (input(env,"verification") && input(env,"verification") !== "digest"))) throw new Error("Remote inputs require tag");
  const remote = config?.schema === 2 ? await prepareReleaseSet(o,env,deadline,config,client) :
    input(env,"tag") ? await prepareRelease(o,env,deadline,client,mappings) : undefined;
  let stage: string | undefined;
  try {
    const selected = remote ?? await selectLocal(o,deadline,mappings);
    const selections = selected.selections.map(s=>({...s,to:destination ? `${destination}/${s.to}` : s.to,
      ...(s.aliasOf ? {aliasOf:destination ? `${destination}/${s.aliasOf}` : s.aliasOf} : {})}));
    assertTargets(selections.map(s=>s.to));
    const base = input(env,"site") ? await selectSite(o.workspace,input(env,"site"),deadline) : undefined;
    const temp = await realpath(o.temp);
    stage = await mkdtemp(join(temp,"releaseway-distribute-"));
    for (const root of [selected.root,...(base ? [base.root]:[])]) if (inside(root,stage) || inside(stage,root)) throw new Error("Output must be separate from input root");
    const path = join(stage,"site"); await mkdir(path,{mode:0o755});
    const files = new Map<string, FileRecord>(); let total = 0;
    const finalPaths = new Set([...(base?.selections.map(s=>s.to) ?? []),...selections.map(s=>s.to)]);
    assertTargets([...finalPaths]);
    if (finalPaths.size > 100_000) throw new Error("Output exceeds 100000 files");
    const replaced = new Set(conflict === "replace" ? selections.map(s=>s.to) : []);
    for (const s of base?.selections ?? []) {
      if (replaced.has(s.to)) continue;
      const f = await copyFile(s.source,join(path,s.to),s.to,Math.min(o.maxFile,o.maxTotal-total),"base",deadline);
      total += f.size; files.set(s.to,f);
    }
    function verifyReleaseCopy(s: Selection, file: {sha256:string; size:number}) {
      if (!remote) return;
      const expected = remote.source.kind === "github-release-set" ? remote.source.releases.find(r=>r.releaseId===s.releaseId)?.assets.find(a=>a.id===s.assetId && a.name===s.from) : remote.source.assets.find(a=>a.name===s.from);
      if (!expected || expected.digest !== `sha256:${file.sha256}` || expected.size !== file.size) throw new Error("Final copy does not match Release asset");
    }
    function provenance(s: Selection) { return {from:s.from,...(s.releaseId ? {releaseId:s.releaseId,assetId:s.assetId,...(s.aliasOf ? {aliasOf:s.aliasOf} : {})} : {})}; }
    for (const s of selections) {
      const old = files.get(s.to);
      if (old) {
        const bytes = await hashFile(s.source,o.maxFile,deadline);
        verifyReleaseCopy(s,bytes);
        if (old.size === bytes.size && old.sha256 === bytes.sha256) {
          await chmod(join(path,s.to),0o644 | ((await stat(s.source)).mode & 0o111));
          files.set(s.to,{...old,origin:"selected",...provenance(s)}); continue;
        }
        if (conflict !== "replace") throw new Error("Selected file conflicts with baseline; use conflict: replace explicitly");
      }
      const target = join(path,s.to), pending = join(stage,"replacement");
      const f = await copyFile(s.source,pending,s.to,Math.min(o.maxFile,o.maxTotal-total+(old?.size??0)),"selected",deadline);
      verifyReleaseCopy(s,f);
      await mkdir(join(target,".."),{recursive:true,mode:0o755});
      if (old) await rm(target);
      await rename(pending,target);
      total += f.size-(old?.size??0); files.set(s.to,{...f,...provenance(s)});
    }
    await remote?.verifySnapshot();
    const inventory = ordered([...files.values()]), digest = contentDigest(inventory), report = join(stage,"report.json");
    const value = {schema:config?.schema === 2 ? 2 : 1,source:remote?.source??{kind:"local",verification:"digest"},base:Boolean(base),
      ...(config?.schema === 2 ? {baseline:base ? {kind:"local-site"} : null} : {}),digest,files:inventory};
    reportShape(value);
    const bytes = JSON.stringify(value,null,2)+"\n";
    if (Buffer.byteLength(bytes)>32*1024**2) throw new Error("Report exceeds 32 MiB");
    await writeFile(report,bytes,{mode:0o600});
    if (env.GITHUB_OUTPUT) {
      if (/[\r\n]/.test(path+report)) throw new Error("Invalid output directory");
      await appendFile(env.GITHUB_OUTPUT,`path=${path}\nreport=${report}\ndigest=${digest}\n`);
    }
    return {path,report,digest};
  } catch(error) { if(stage) await rm(stage,{recursive:true,force:true}); throw error; }
  finally { await remote?.cleanup(); }
}
