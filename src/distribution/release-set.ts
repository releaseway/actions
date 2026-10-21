import { compare, prerelease, satisfies, valid } from "semver";
import type { ReleaseSetConfig, RequiredMapping } from "./config.ts";
import type { ReleaseClient } from "./gh.ts";
import { assertTargets, publicPath } from "./paths.ts";
import { repositoryName } from "./release.ts";
import { snapshotRelease } from "./release.ts";
import { createHash } from "node:crypto";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { input, type Options, type Environment } from "./inputs.ts";
import { GhClient } from "./gh.ts";
import { hashFile } from "./copy.ts";
import type { Selection } from "./local.ts";

export interface ReleaseSummary { id: number; tag: string; draft: boolean; prerelease: boolean; immutable: boolean }
export interface ReleaseAsset { id: number; name: string; size: number; digest: string; state: "uploaded" }
export interface AssetMapping extends RequiredMapping { asset: ReleaseAsset }
export interface AssetSelection { status: "selected" | "skipped-empty"; assets: ReleaseAsset[]; files: AssetMapping[] }
export const releaseProjection = 'if type == "array" then map(if type == "object" then {id, tag_name, draft, prerelease, immutable} else . end) else . end';
export function positiveId(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
export function releaseSummary(value: any): ReleaseSummary {
  if (!value || !positiveId(value.id) || typeof value.tag_name !== "string" || !value.tag_name ||
      /[\x00-\x1f\x7f]/.test(value.tag_name) || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean" ||
      (value.immutable !== undefined && typeof value.immutable !== "boolean")) throw new Error("Invalid Release inventory item");
  return {id:value.id,tag:value.tag_name,draft:value.draft,prerelease:value.prerelease,immutable:value.immutable === true};
}
export async function releaseInventory(gh: ReleaseClient, repository: string): Promise<ReleaseSummary[]> {
  repositoryName(repository);
  const result: ReleaseSummary[] = [], ids = new Set<number>(), tags = new Set<string>();
  for (let page=1;page<=20;page++) {
    const batch = await gh.json(`repos/${repository}/releases?per_page=100&page=${page}`,releaseProjection);
    if (!Array.isArray(batch) || batch.length>100) throw new Error("Invalid Release inventory page");
    for (const item of batch) {
      const r=releaseSummary(item);
      if (ids.has(r.id) || tags.has(r.tag)) throw new Error("Duplicate Release ID or tag in inventory");
      ids.add(r.id);tags.add(r.tag);result.push(r);
    }
    if (batch.length<100) return result;
  }
  throw new Error("Release inventory exceeds pagination budget");
}
export function selectReleases(config: ReleaseSetConfig, inventory: ReleaseSummary[]) {
  const selector=config.releases;
  let releases: ReleaseSummary[];
  let version: (r:ReleaseSummary)=>string = r=>r.tag;
  if ("tags" in selector) {
    releases=selector.tags.map(tag=>{
      const found=inventory.find(r=>r.tag===tag);
      if (!found || found.draft) throw new Error("Requested Release is missing or draft");
      return found;
    });
  } else {
    version=r=>r.tag.slice(selector.tagPrefix.length);
    releases=inventory.filter(r=>!r.draft && r.tag.startsWith(selector.tagPrefix) && valid(version(r)) === version(r) &&
      !version(r).includes("+") && (selector.includePrereleases || (!r.prerelease && prerelease(version(r)) === null)) &&
      satisfies(version(r),selector.range,{includePrerelease:selector.includePrereleases}));
    releases.sort((a,b)=>compare(version(a),version(b)) || Buffer.compare(Buffer.from(a.tag),Buffer.from(b.tag)));
  }
  if (!releases.length) throw new Error("No matching published Releases");
  for (const r of releases) publicPath(r.tag);
  let alias: ReleaseSummary | undefined;
  if (config.aliases) {
    alias=config.aliases.tag ? releases.find(r=>r.tag===config.aliases!.tag) : releases.filter(r=>!r.prerelease && prerelease(version(r)) === null).at(-1);
    if (!alias) throw new Error("Alias Release is not selected or no stable Release exists");
  }
  assertTargets([...releases.flatMap(r=>config.files.map(f=>`${r.tag}/${f.to}`)),...(config.aliases?.files.map(f=>f.to)??[])]);
  return {releases,alias};
}
export async function discoverReleaseSet(gh: ReleaseClient, repository: string, config: ReleaseSetConfig) {
  repositoryName(repository);
  if ((await gh.json(`repos/${repository}`)).private !== false) throw new Error("Only public github.com repositories are supported");
  return selectReleases(config,await releaseInventory(gh,repository));
}
export function selectAssets(config: ReleaseSetConfig, assets: unknown, maximum: number): AssetSelection {
  if (!Array.isArray(assets)) throw new Error("Invalid Release asset inventory");
  const selected = new Map<number,ReleaseAsset>(), files:AssetMapping[]=[];
  for (const mapping of config.files) {
    const matches=assets.filter(a=>a && a.name === mapping.from);
    if (matches.length>1) throw new Error("Duplicate Release asset name");
    if (!matches.length) continue;
    const a=matches[0];
    if (!positiveId(a.id) || a.state!=="uploaded" || !Number.isSafeInteger(a.size) || a.size<0 || a.size>maximum ||
        typeof a.digest!=="string" || !/^sha256:[a-f0-9]{64}$/.test(a.digest)) throw new Error("Invalid uploaded asset ID, size or SHA-256 digest");
    const asset:ReleaseAsset={id:a.id,name:a.name,size:a.size,digest:a.digest,state:"uploaded"};
    if (selected.has(a.id) && selected.get(a.id)!.name!==a.name) throw new Error("Duplicate Release asset ID");
    selected.set(a.id,asset);files.push({...mapping,asset});
  }
  if (!files.length) {
    if (config.releases.onEmpty!=="skip") throw new Error("Release has no configured assets");
    return {status:"skipped-empty",assets:[],files:[]};
  }
  if (config.files.some(f=>f.required && !files.some(m=>m.from===f.from))) throw new Error("Release is missing required assets");
  return {status:"selected",assets:[...selected.values()],files};
}

export interface SetRelease {
  releaseId: number; tag: string; commit: string; prerelease: boolean; immutable: boolean;
  status: "selected" | "skipped-empty"; assets: ReleaseAsset[];
}
export interface ReleaseSetSource {
  kind: "github-release-set"; repository: string; verification: "digest" | "attested";
  policy: ReturnType<typeof rawPolicy>; policyDigest: string; destination: string; releases: SetRelease[]; aliasTag: string | null;
}
export function rawPolicy(c: ReleaseSetConfig) {
  const r=c.releases;
  return {schema:2, releases:"tags" in r ? {tags:r.tags,"on-empty":r.onEmpty} :
    {"tag-prefix":r.tagPrefix,range:r.range,"include-prereleases":r.includePrereleases,"on-empty":r.onEmpty},
    files:c.files,...(c.aliases ? {aliases:c.aliases} : {})};
}
export function policyDigest(c: ReleaseSetConfig) { return `sha256:${createHash("sha256").update(JSON.stringify(rawPolicy(c))).digest("hex")}`; }
function metadata(r: SetRelease): ReleaseSummary { return {id:r.releaseId,tag:r.tag,draft:false,prerelease:r.prerelease,immutable:r.immutable}; }
async function candidate(gh: ReleaseClient, repository: string, config: ReleaseSetConfig, r: ReleaseSummary, maximum: number) {
  const snapshot=await snapshotRelease(gh,repository,r.tag);
  if (JSON.stringify(releaseSummary(snapshot.release))!==JSON.stringify(r)) throw new Error("source-changed: Release metadata changed during discovery");
  const selected=selectAssets(config,snapshot.assets,maximum);
  const record:SetRelease={releaseId:r.id,tag:r.tag,commit:snapshot.commit,prerelease:r.prerelease,immutable:r.immutable,status:selected.status,assets:selected.assets};
  return {record,files:selected.files};
}
export async function verifyReleaseSet(gh: ReleaseClient, source: ReleaseSetSource, config: ReleaseSetConfig) {
  const current=await discoverReleaseSet(gh,source.repository,config);
  if (JSON.stringify(current.releases)!==JSON.stringify(source.releases.map(metadata)) || (current.alias?.tag??null)!==source.aliasTag) throw new Error("superseded: selected Release set changed; rerun the entire workflow");
  for (const r of current.releases) {
    const {record}=await candidate(gh,source.repository,config,r,8*1024**3);
    if (JSON.stringify(record)!==JSON.stringify(source.releases.find(before=>before.releaseId===r.id))) throw new Error("source-changed: Release or tag changed while preparing files");
  }
}
export async function prepareReleaseSet(o: Options, env: Environment, deadline: number, config: ReleaseSetConfig, client?: ReleaseClient) {
  if (input(env,"tag") || o.root || input(env,"commit")) throw new Error("Release-set config cannot be combined with tag, root or commit");
  const repository=repositoryName(input(env,"repository") || env.GITHUB_REPOSITORY || "");
  const verification=input(env,"verification") || "digest";
  if (verification!=="digest" && verification!=="attested") throw new Error("Unknown verification mode");
  const scratch=await mkdtemp(join(o.temp,"releaseway-source-"));
  try {
    const gh=client??new GhClient(input(env,"token"),join(scratch,"cache"),deadline);
    const discovered=await discoverReleaseSet(gh,repository,config);
    const records:SetRelease[]=[], planned:Array<{record:SetRelease;file:AssetMapping;to:string;aliasOf?:string}>=[];
    for (const r of discovered.releases) {
      const {record,files}=await candidate(gh,repository,config,r,o.maxFile);
      records.push(record);
      if (record.status==="skipped-empty" && r.tag===discovered.alias?.tag) throw new Error("Alias Release has no required assets");
      for (const file of files) planned.push({record,file,to:`${r.tag}/${file.to}`});
      if (r.tag===discovered.alias?.tag) for (const a of config.aliases!.files) {
        const file=files.find(f=>f.to===a.from)!;
        planned.push({record,file,to:a.to,aliasOf:`${r.tag}/${file.to}`});
      }
    }
    if (!planned.length) throw new Error("No Release files remain after empty skips");
    assertTargets(planned.map(f=>f.to));
    if (planned.length>10_000) throw new Error("Selection exceeds 10000 files");
    if (planned.reduce((total,p)=>total+p.file.asset.size,0)>o.maxTotal) throw new Error("Selected assets exceed total byte limit");
    const source:ReleaseSetSource={kind:"github-release-set",repository,verification,policy:rawPolicy(config),policyDigest:policyDigest(config),
      destination:input(env,"destination"),releases:records,aliasTag:discovered.alias?.tag??null};
    const downloaded=new Map<string,string>(),selections:Selection[]=[];
    for (const p of planned) {
      const asset=p.file.asset,key=`${p.record.releaseId}-${asset.id}`;
      let path=downloaded.get(key);
      if (!path) {
        path=join(scratch,`asset-${key}`);
        await gh.download(`repos/${repository}/releases/assets/${asset.id}`,path,asset.size);
        const bytes=await hashFile(path,o.maxFile,deadline);
        if (bytes.size!==asset.size || `sha256:${bytes.sha256}`!==asset.digest) throw new Error("Release asset bytes do not match digest");
        if (verification==="attested") await gh.verify(p.record.tag,path,repository);
        await chmod(path,0o644);downloaded.set(key,path);
      }
      selections.push({source:path,from:asset.name,to:p.to,releaseId:p.record.releaseId,assetId:asset.id,...(p.aliasOf ? {aliasOf:p.aliasOf} : {})});
    }
    return {root:scratch,selections,source,verifySnapshot:()=>verifyReleaseSet(gh,source,config),cleanup:()=>rm(scratch,{recursive:true,force:true})};
  } catch(error) { await rm(scratch,{recursive:true,force:true});throw error; }
}
