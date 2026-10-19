import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join, posix } from "node:path";
import { input, type Environment, type Options } from "./inputs.ts";
import { GhClient, type ReleaseClient } from "./gh.ts";
import { pattern, publicPath, visible, assertTargets } from "./paths.ts";
import { hashFile } from "./copy.ts";
import type { Mapping } from "./config.ts";
import type { Selection } from "./local.ts";
export function repositoryName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) || [".",".."].includes(value.split("/")[1])) throw new Error("repository must be owner/name on github.com");
  return value;
}
function validId(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
export async function prepareRelease(o: Options, env: Environment, deadline: number, client?: ReleaseClient, mappings?: Mapping[]) {
  if (o.root) throw new Error("root is only supported for local source");
  const repository = repositoryName(input(env, "repository") || env.GITHUB_REPOSITORY || "");
  const tag = input(env, "tag");
  if (!tag || /[\x00-\x1f\x7f]/.test(tag)) throw new Error("tag must be an exact literal tag");
  const expected = input(env, "commit");
  if (expected && !/^[a-f0-9]{40}$/i.test(expected)) throw new Error("commit must be a full SHA");
  const verification = input(env, "verification") || "digest";
  if (!["digest", "attested"].includes(verification)) throw new Error("Unknown verification mode");
  if (!client && !input(env,"token")) throw new Error("Release reads require token (defaults to github.token) with contents:read");
  const scratch = await mkdtemp(join(o.temp, "releaseway-source-"));
  const gh = client ?? new GhClient(input(env, "token"), join(scratch, "cache"), deadline);
  const base = `repos/${repository}`;
  async function snapshot() {
    const repo = await gh.json(base);
    if (repo.private !== false) throw new Error("Only public github.com repositories are supported");
    const release = await gh.json(`${base}/releases/tags/${encodeURIComponent(tag)}`);
    if (!validId(release.id) || release.tag_name !== tag || release.draft !== false) throw new Error("Release is missing, draft or does not match the exact tag");
    let object = (await gh.json(`${base}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
    const seen = new Set<string>();
    for (let depth = 0; object?.type === "tag"; depth++) {
      if (depth >= 16 || seen.has(object.sha) || !/^[a-f0-9]{40}$/i.test(object.sha)) throw new Error("Invalid annotated tag chain");
      seen.add(object.sha); object = (await gh.json(`${base}/git/tags/${object.sha}`)).object;
    }
    if (object?.type !== "commit" || !/^[a-f0-9]{40}$/i.test(object.sha)) throw new Error("Tag does not resolve to a commit");
    const commit = object.sha.toLowerCase();
    if (expected && commit !== expected.toLowerCase()) throw new Error("Tag commit does not match expected commit");
    const assets: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await gh.json(`${base}/releases/${release.id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(batch) || batch.length > 100) throw new Error("Invalid Release asset page");
      assets.push(...batch);
      if (batch.length < 100) break;
      if (page === 20) throw new Error("Release exceeds asset pagination budget");
    }
    return { release, commit, assets };
  }
  try {
    const before = await snapshot();
    const selected = new Map<string, any>();
    for (const request of mappings?.map(m=>m.from) ?? o.files) {
      if (!mappings) pattern(request);
      if (request.includes("/")) throw new Error("Release assets have flat names");
      const matches = before.assets.filter(a => typeof a.name === "string" && visible(a.name, request) && (mappings ? a.name === request : posix.matchesGlob(a.name, request)));
      if (!matches.length) throw new Error("A Release files pattern matched no assets");
      for (const a of matches) {
        if (!mappings) publicPath(a.name);
        if (!validId(a.id) || a.state !== "uploaded" || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > o.maxFile || !/^sha256:[a-f0-9]{64}$/.test(a.digest)) throw new Error("Invalid uploaded asset ID, size or SHA-256 digest");
        if (before.assets.filter(other => other.name === a.name).length !== 1) throw new Error("Duplicate Release asset name");
        const old = selected.get(a.name);
        if (old && old.id !== a.id) throw new Error("Duplicate Release asset name");
        selected.set(a.name, a);
      }
    }
    if (selected.size > 10_000) throw new Error("Selection exceeds 10000 files");
    if (!mappings) assertTargets([...selected.keys()]);
    let total = 0;
    const selections: Selection[] = [];
    for (const a of selected.values()) {
      total += a.size;
      if (total > o.maxTotal) throw new Error("Selected assets exceed total byte limit");
      const source = join(scratch, `asset-${a.id}`);
      await gh.download(`${base}/releases/assets/${a.id}`, source, a.size);
      const actual = await hashFile(source, o.maxFile, deadline);
      if (actual.size !== a.size || `sha256:${actual.sha256}` !== a.digest) throw new Error("Release asset bytes do not match digest");
      if (verification === "attested") await gh.verify(tag, source, repository);
      await chmod(source, 0o644);
      selections.push({ source, from: a.name, to: a.name });
    }
    const identity = (s: Awaited<ReturnType<typeof snapshot>>) => JSON.stringify({ id:s.release.id, commit:s.commit, immutable:s.release.immutable === true,
      assets:[...selected.keys()].sort().map(name => s.assets.filter(a => a.name === name).map(a => [a.id,a.name,a.size,a.digest,a.state])) });
    const verifySnapshot = async () => { if (identity(before) !== identity(await snapshot())) throw new Error("Release or tag changed while preparing files"); };
    const layout = mappings ? mappings.map(m => { const s = selections.find(s=>s.from===m.from); if (!s) throw new Error("Missing mapped asset"); return {...s,to:m.to}; }) : selections;
    assertTargets(layout.map(s=>s.to));
    return { root: scratch, selections: layout, source: { kind:"github-release", repository, tag, releaseId:before.release.id, commit:before.commit, immutable:before.release.immutable === true, verification,
      assets:[...selected.values()].map(a => ({id:a.id,name:a.name,size:a.size,digest:a.digest})) }, verifySnapshot, cleanup: () => rm(scratch,{recursive:true,force:true}) };
  } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
}
