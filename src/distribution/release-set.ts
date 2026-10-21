import { compare, prerelease, satisfies, valid } from "semver";
import type { ReleaseSetConfig, RequiredMapping } from "./config.ts";
import type { ReleaseClient } from "./gh.ts";
import { assertTargets, publicPath } from "./paths.ts";
import { repositoryName } from "./release.ts";

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
