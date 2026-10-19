import { appendFile, readFile, writeFile, stat, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { input, type Environment } from "./inputs.ts";
import { GhClient, type ReleaseClient } from "./gh.ts";
import { repositoryName } from "./release.ts";
import { assertTargets, publicPath } from "./paths.ts";
import { contentDigest, ordered, type FileRecord } from "./report.ts";
import { hashFile } from "./copy.ts";
import { selectSite } from "./site.ts";
import { distribute } from "./action.ts";
import { verifyServed } from "./verify-served.ts";
const MAX_REPORT=32*1024**2;
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
export async function output(env: Environment, values: Record<string,string>) {
  if(Object.values(values).some(v=>/[\r\n]/.test(v)))throw new Error("Invalid multiline internal output");
  if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join(""));
  return values;
}
export function reportShape(value:any): FileRecord[] {
  if(value?.schema!==1 || !Array.isArray(value.files) || !value.files.length || value.files.length>100_000)throw new Error("Invalid distribution report schema");
  let total=0;
  for(const f of value.files) {
    if(typeof f.path!=="string" || !Number.isSafeInteger(f.size) || f.size<0 || !/^[a-f0-9]{64}$/.test(f.sha256) || !["base","selected"].includes(f.origin))throw new Error("Invalid report file");
    publicPath(f.path);total+=f.size;
    if(total>8*1024**3)throw new Error("Report exceeds byte limit");
  }
  assertTargets(value.files.map((f:FileRecord)=>f.path));
  if(value.digest!==contentDigest(value.files))throw new Error("Report content identity mismatch");
  return value.files;
}
export async function loadReport(path:string, expected?:string) {
  if((await stat(path)).size>MAX_REPORT)throw new Error("Report exceeds 32 MiB");
  const bytes=await readFile(path);
  if(bytes.length>MAX_REPORT || (expected && sha(bytes)!==expected))throw new Error("Report artifact hash mismatch");
  let report:any;try{report=JSON.parse(bytes.toString("utf8"));}catch{throw new Error("Invalid report JSON");}
  reportShape(report);return report;
}
export function pagesEvent(env:Environment) {
  if(!["release","workflow_dispatch","push"].includes(env.GITHUB_EVENT_NAME??""))throw new Error("Pages publishing requires a trusted release, dispatch or push caller");
  if(env.GITHUB_SERVER_URL!=="https://github.com")throw new Error("Pages adapter supports github.com only");
}
async function latest(gh:ReleaseClient,repository:string){
 const r=await gh.json(`repos/${repository}/releases/latest`);
 if(!Number.isSafeInteger(r.id)||r.id<1||typeof r.tag_name!=="string"||r.draft!==false||r.prerelease!==false)throw new Error("No published latest-stable Release");
 return r;
}
export async function resolvePages(env:Environment,gh:ReleaseClient) {
  pagesEvent(env);
  const tag=input(env,"tag"),artifact=input(env,"artifact-id"),repo=repositoryName(input(env,"repository")||env.GITHUB_REPOSITORY||"");
  if(tag && artifact)throw new Error("Choose tag or artifact-id, not both");
  if(Boolean(input(env,"files"))===Boolean(input(env,"config")))throw new Error("Provide exactly one of files or config");
  let selectedTag=tag,latestId="";
  if(artifact){
    if(!/^[1-9]\d*$/.test(artifact)||!Number.isSafeInteger(Number(artifact)))throw new Error("Invalid artifact-id");
    if(input(env,"repository"))throw new Error("repository override is only for Release source");
    const a=await gh.json(`repos/${repo}/actions/artifacts/${artifact}`),run=await gh.json(`repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}`);
    if(a.id!==Number(artifact)||a.expired!==false||a.workflow_run?.id!==Number(env.GITHUB_RUN_ID)||a.workflow_run?.repository_id!==Number(env.GITHUB_REPOSITORY_ID)||a.workflow_run?.head_sha!==run.head_sha || !/^[a-f0-9]{40}$/i.test(run.head_sha)||!Number.isSafeInteger(a.size_in_bytes)||a.size_in_bytes<0||a.size_in_bytes>2*1024**3||!/^sha256:[a-f0-9]{64}$/.test(a.digest))throw new Error("Artifact is expired, oversized or not from this repository/workflow run");
  }else if(!tag){const r=await latest(gh,repo);selectedTag=r.tag_name;latestId=String(r.id);}
  const invocation=`releaseway-pages-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${randomUUID()}`;
  return output(env,{tag:selectedTag,"artifact-id":artifact,"latest-id":latestId,"repository":repo,"artifact-name":invocation,"report-name":invocation+"-report"});
}
export async function finalizePages(env:Environment) {
  const path=input(env,"path"),core=await loadReport(input(env,"report")),files=reportShape(core);
  if(input(env,"latest-id") && String(core.source?.releaseId)!==input(env,"latest-id"))throw new Error("Latest Release changed before file preparation");
  const tree=await selectSite(env.GITHUB_WORKSPACE!,path,Date.now()+600_000);
  if(JSON.stringify(tree.selections.map(s=>s.to).sort())!==JSON.stringify(files.map(f=>f.path).sort()))throw new Error("Prepared tree/report membership mismatch");
  let total=0;
  for(const f of files){if(f.path.split("/").some(p=>p.toLowerCase()===".github"))throw new Error("Pages packaging excludes .github segments");total+=f.size;const actual=await hashFile(join(path,f.path),f.size);if(actual.sha256!==f.sha256 || actual.size!==f.size)throw new Error("Prepared tree/report bytes mismatch");}
  if(total>1_000_000_000)throw new Error("Pages site exceeds 1000000000 bytes");
  const old=files.find(f=>f.path===".nojekyll");
  if(old && old.size!==0)throw new Error("Nonempty .nojekyll conflicts with Pages delivery");
  if(!old){assertTargets([...files.map(f=>f.path),".nojekyll"]);await writeFile(join(path,".nojekyll"),"",{flag:"wx",mode:0o644});files.push({path:".nojekyll",size:0,sha256:sha(""),origin:"selected"});}
  const folder=await mkdtemp(join(env.RUNNER_TEMP!,"releaseway-pages-report-")),report=join(folder,"report.json");
  const delivery={schema:1,source:core.source,latestId:input(env,"latest-id"),contentDigest:core.digest,digest:contentDigest(files),files:ordered(files)};
  reportShape(delivery);
  const bytes=JSON.stringify(delivery,null,2)+"\n";
  if(Buffer.byteLength(bytes)>MAX_REPORT)throw new Error("Delivery report exceeds limit");
  await writeFile(report,bytes,{mode:0o600});
  return output(env,{"report":report,"report-sha":sha(bytes),"delivery-digest":delivery.digest,"content-digest":core.digest});
}
export async function checkArchive(env:Environment) {
  const report=await loadReport(input(env,"report"),input(env,"report-sha"));
  const archive=join(env.RUNNER_TEMP!,"artifact.tar");
  if((await stat(archive)).size>1_000_000_000)throw new Error("Pages archive exceeds byte limit including tar overhead");
  const run=promisify(execFile),opts={timeout:30_000,maxBuffer:MAX_REPORT};
  const {stdout}=await run("tar",["--list","--quoting-style=literal","--file",archive],opts);
  const detail=await run("tar",["--list","--verbose","--file",archive],opts);
  if(detail.stdout.split("\n").filter(Boolean).some(l=>!["d","-"].includes(l[0])))throw new Error("Pages archive contains link or special members");
  const members=stdout.split("\n").filter(p=>p && !p.endsWith("/")).map(p=>p.startsWith("./")?p.slice(2):p);
  assertTargets(members);
  if(JSON.stringify(members.sort())!==JSON.stringify(report.files.map((f:FileRecord)=>f.path).sort()))throw new Error("Pages archive/report membership mismatch");
}
export async function guardPages(env:Environment,gh:ReleaseClient) {
  const expected=input(env,"report-sha");if(!/^[a-f0-9]{64}$/.test(expected))throw new Error("Expected report SHA is required");
  const report=await loadReport(input(env,"report"),expected);
  if(report.latestId && String((await latest(gh,repositoryName(report.source.repository))).id)!==report.latestId)throw new Error("superseded: latest changed; rerun the entire workflow");
  return report;
}
export async function environmentDeployment(env:Environment,gh:ReleaseClient):Promise<string> {
  const repo=repositoryName(env.GITHUB_REPOSITORY??""),run=`https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID}/job/${input(env,"check-run-id")}`;
  for(let page=1;page<=20;page++){
    const ds=await gh.json(`repos/${repo}/deployments?environment=github-pages&sha=${env.GITHUB_SHA}&per_page=100&page=${page}`);
    if(!Array.isArray(ds))throw new Error("Invalid deployment list");
    for(const d of ds){if(d.environment!=="github-pages" || d.sha!==env.GITHUB_SHA || !Number.isSafeInteger(d.id))continue;
      const statuses=await gh.json(`repos/${repo}/deployments/${d.id}/statuses?per_page=100`);
      if(Array.isArray(statuses)&&statuses.some(s=>s.log_url===run))return String(d.id);
    }
    if(ds.length<100)break;
  }
  throw new Error("No environment deployment matches this exact run/job");
}
export async function runPages(env:Environment=process.env) {
  const op=input(env,"operation");
  const gh=new GhClient(input(env,"token"),join(env.RUNNER_TEMP!,"releaseway-gh-cache"));
  if(op==="resolve")return resolvePages(env,gh);
  if(op==="prepare") {
    const source=input(env,"source-path");
    if(source){const tree=await selectSite(env.GITHUB_WORKSPACE!,source,Date.now()+600_000);let total=0;for(const s of tree.selections){total+=(await stat(s.source)).size;if(total>2*1024**3)throw new Error("Extracted artifact exceeds 2 GiB");}}
    return distribute({...env,GITHUB_WORKSPACE:source||env.GITHUB_WORKSPACE},gh,env.GITHUB_WORKSPACE);
  }
  if(op==="deployment") return output(env,{"deployment-id":await environmentDeployment(env,gh)});
  if(op==="finalize")return finalizePages(env);
  if(op==="archive")return checkArchive(env);
  if(op==="guard"){await guardPages(env,gh);return;}
  if(op==="verify"){
    const r=await guardPages(env,gh);
    await verifyServed(input(env,"page-url"),r.files);
    await guardPages(env,gh);
    return;
  }
  throw new Error("Unknown internal distribution operation");
}
