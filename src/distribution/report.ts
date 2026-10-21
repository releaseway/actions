import { createHash } from "node:crypto";
import { publicPath, assertTargets } from "./paths.ts";
import { parseConfig } from "./config.ts";
import { policyDigest, positiveId, selectReleases, selectAssets, type ReleaseSetSource } from "./release-set.ts";
import { repositoryName } from "./release.ts";
export interface FileRecord { path: string; size: number; sha256: string; origin: "selected" | "base"; from?: string; releaseId?: number; assetId?: number; aliasOf?: string; generatedBy?: "pages" }
export function ordered(files: FileRecord[]): FileRecord[] {
  return files.slice().sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
export function contentDigest(files: FileRecord[]): string {
  const bytes = JSON.stringify(ordered(files).map(f => [f.path, f.size, f.sha256]));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function releaseSetPolicy(source: ReleaseSetSource) {
  const config=parseConfig(source.policy);
  if (config.schema!==2 || policyDigest(config)!==source.policyDigest) throw new Error("Release-set policy identity mismatch");
  return config;
}
function validateSetReport(value:any) {
  const source=value.source as ReleaseSetSource;
  if (source?.kind!=="github-release-set" || !["digest","attested"].includes(source.verification)) throw new Error("Invalid Release-set source");
  repositoryName(source.repository);
  if (typeof source.destination!=="string") throw new Error("Missing Release-set destination");
  if (source.destination) publicPath(source.destination);
  const config=releaseSetPolicy(source);
  if (!Array.isArray(source.releases) || !source.releases.length || source.releases.length>2000) throw new Error("Invalid Release-set candidates");
  const ids=new Set<number>(),tags=new Set<string>();
  const expected=new Map<string,{releaseId:number;assetId:number;from:string;size:number;digest:string;aliasOf?:string}>();
  const full=(p:string)=>source.destination ? `${source.destination}/${p}` : p;
  for (const r of source.releases) {
    if (!positiveId(r.releaseId) || ids.has(r.releaseId) || tags.has(r.tag) || typeof r.commit!=="string" || !/^[a-f0-9]{40}$/.test(r.commit) ||
        typeof r.prerelease!=="boolean" || typeof r.immutable!=="boolean") throw new Error("Invalid Release-set candidate identity");
    publicPath(r.tag);ids.add(r.releaseId);tags.add(r.tag);
    const selected=selectAssets(config,r.assets,8*1024**3);
    if (selected.status!==r.status || selected.assets.length!==r.assets.length) throw new Error("Release-set candidate classification mismatch");
    for (const f of selected.files) {
      const fields={releaseId:r.releaseId,assetId:f.asset.id,from:f.asset.name,size:f.asset.size,digest:f.asset.digest};
      const path=full(`${r.tag}/${f.to}`);
      if (expected.has(path)) throw new Error("Duplicate Release-set target");
      expected.set(path,fields);
      if (r.tag===source.aliasTag) for (const a of config.aliases?.files.filter(a=>a.from===f.to)??[]) {
        const alias=full(a.to);
        if (expected.has(alias)) throw new Error("Duplicate Release-set alias");
        expected.set(alias,{...fields,aliasOf:path});
      }
    }
  }
  const chosen=selectReleases(config,source.releases.map(r=>({id:r.releaseId,tag:r.tag,draft:false,prerelease:r.prerelease,immutable:r.immutable})));
  if (chosen.releases.length!==source.releases.length || (chosen.alias?.tag??null)!==source.aliasTag ||
      (source.aliasTag && source.releases.find(r=>r.tag===source.aliasTag)?.status!=="selected") || !expected.size) throw new Error("Invalid Release-set selection or alias");
  if (!("baseline" in value) || value.base!==Boolean(value.baseline)) throw new Error("Invalid baseline provenance");
  if (value.baseline && !["local-site","workflow-artifact"].includes(value.baseline.kind)) throw new Error("Invalid baseline kind");
  if (value.baseline?.kind==="workflow-artifact") {
    const b=value.baseline;
    repositoryName(b.repository);
    if (![b.artifactId,b.runId].every(v=>typeof v==="string" && /^[1-9]\d*$/.test(v)) || !/^sha256:[a-f0-9]{64}$/.test(b.artifactDigest) ||
        ![b.headSha,b.callerSha].every(v=>typeof v==="string" && /^[a-f0-9]{40}$/i.test(v))) throw new Error("Invalid baseline artifact identity");
  }
  for (const f of value.files as FileRecord[]) {
    const e=expected.get(f.path);
    if (e) {
      if (f.origin!=="selected" || f.releaseId!==e.releaseId || f.assetId!==e.assetId || f.from!==e.from || f.size!==e.size || `sha256:${f.sha256}`!==e.digest || f.aliasOf!==e.aliasOf || f.generatedBy) throw new Error("Release-set file provenance mismatch");
      expected.delete(f.path);
    } else if (f.generatedBy==="pages" && f.path===".nojekyll" && f.size===0 && f.origin==="selected" && f.sha256===createHash("sha256").update("").digest("hex") && f.releaseId===undefined && f.assetId===undefined && f.aliasOf===undefined) {
      // The delivery adapter, rather than a Release, owns this generated file.
    } else if (!value.baseline || f.origin!=="base" || f.releaseId!==undefined || f.assetId!==undefined || f.aliasOf!==undefined || f.generatedBy!==undefined) throw new Error("Unexpected Release-set file");
  }
  if (expected.size) throw new Error("Release-set report is missing selected files");
}
export function reportShape(value:any): FileRecord[] {
  if (![1,2].includes(value?.schema) || !Array.isArray(value.files) || !value.files.length || value.files.length>100_000) throw new Error("Invalid distribution report schema");
  let total=0;
  for (const f of value.files) {
    if (!f || typeof f.path!=="string" || !Number.isSafeInteger(f.size) || f.size<0 || !/^[a-f0-9]{64}$/.test(f.sha256) || !["base","selected"].includes(f.origin)) throw new Error("Invalid report file");
    publicPath(f.path);total+=f.size;
    if (total>8*1024**3) throw new Error("Report exceeds byte limit");
  }
  assertTargets(value.files.map((f:FileRecord)=>f.path));
  if (value.digest!==contentDigest(value.files)) throw new Error("Report content identity mismatch");
  if (value.schema===2) validateSetReport(value);
  return value.files;
}
