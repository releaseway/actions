import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
import { resolvePages,runPages,finalizePages,loadReport,guardPages,checkArchive } from "../src/distribution/pages.ts";

const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),"pages-release-set-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const name of ["work/source","temp/site/.well-known"])await mkdir(join(dir,name),{recursive:true});
  const policy={schema:2,releases:{"tag-prefix":"v",range:">=1.0.0 <2.0.0"},files:[{from:"install.sh",to:"install.sh"}],aliases:{select:"highest-stable",files:[{from:"install.sh",to:"install.sh"}]}};
  await writeFile(join(dir,"work/source/policy.json"),JSON.stringify(policy));
  await writeFile(join(dir,"temp/site/index.html"),"docs");
  await writeFile(join(dir,"temp/site/.well-known/info.json"),"{}");
  await writeFile(join(dir,"temp/site/policy.json"),"untrusted artifact policy is never read");
  const env={GITHUB_WORKSPACE:join(dir,"work"),RUNNER_TEMP:join(dir,"temp"),GITHUB_SERVER_URL:"https://github.com",GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_RUN_ID:"20",GITHUB_RUN_ATTEMPT:"1",GITHUB_REPOSITORY:"owner/example",GITHUB_REPOSITORY_ID:"7",GITHUB_SHA:"a".repeat(40),INPUT_CONFIG:"source/policy.json",INPUT_REPOSITORY:"upstream/app","INPUT_SITE-ARTIFACT-ID":"9"};
  const bytes=Buffer.from("installer");
  const records=[{id:5,tag_name:"v1.0.0",draft:false,prerelease:false,immutable:true,commit:"c".repeat(40)}];
  const api={calls:[],records,
    artifact:{id:9,expired:false,size_in_bytes:25,digest:"sha256:"+"d".repeat(64),workflow_run:{id:20,repository_id:7,head_sha:"b".repeat(40)}},
    asset:{id:8,name:"install.sh",state:"uploaded",size:bytes.length,digest:"sha256:"+hash(bytes)},
    async json(endpoint){
      api.calls.push(endpoint);
      if(endpoint==="repos/owner/example/actions/artifacts/9")return structuredClone(api.artifact);
      if(endpoint==="repos/owner/example/actions/runs/20")return {head_sha:"b".repeat(40)};
      if(endpoint==="repos/upstream/app")return {private:false};
      if(endpoint.includes("repos/upstream/app/releases?"))return records.map(r=>({...r}));
      if(endpoint.includes("/releases/tags/"))return records.find(r=>r.tag_name===decodeURIComponent(endpoint.split("/tags/")[1]));
      if(endpoint.includes("/git/ref/tags/"))return {object:{type:"commit",sha:records.find(r=>r.tag_name===decodeURIComponent(endpoint.split("/tags/")[1])).commit}};
      if(endpoint.includes("/releases/5/assets?"))return [{...api.asset}];
      throw new Error("Unexpected endpoint "+endpoint);
    },
    async download(_endpoint,path){await writeFile(path,bytes);},
    async verify(){throw new Error("unexpected attested verification");}
  };
  return {dir,env,policy,api,site:join(dir,"temp/site")};
}
async function prepare(t) {
  const f=await fixture(t),resolved=await resolvePages(f.env,f.api);
  const core=await runPages({...f.env,INPUT_OPERATION:"prepare","INPUT_SITE-PATH":f.site},f.api);
  const finalEnv={...f.env,INPUT_PATH:core.path,INPUT_REPORT:core.report,"INPUT_SITE-ARTIFACT-DIGEST":resolved["site-artifact-digest"],"INPUT_SITE-HEAD-SHA":resolved["site-head-sha"]};
  return {...f,core,finalEnv,resolved};
}
test("unversioned shorthand follows the same Pages resolve, prepare and delivery contract",async t=>{
  const f=await prepare(t);
  await writeFile(join(f.env.GITHUB_WORKSPACE,"source/policy.json"),JSON.stringify({releases:f.policy.releases,files:["install.sh"],aliases:{select:"highest-stable",files:["install.sh"]}}));
  const resolved=await resolvePages(f.env,f.api);assert.equal(resolved.mode,"release-set");
  const core=await runPages({...f.env,INPUT_OPERATION:"prepare","INPUT_SITE-PATH":f.site},f.api);
  assert.equal(core.digest,f.core.digest);
  const old=await finalizePages(f.finalEnv);
  const modern=await finalizePages({...f.finalEnv,INPUT_PATH:core.path,INPUT_REPORT:core.report});
  const oldReport=await loadReport(old.report),newReport=await loadReport(modern.report);
  assert.deepEqual(newReport,oldReport);
});
test("release-set resolve reads caller policy and validates the caller's site artifact separately from source repo",async t=>{
  const f=await fixture(t),r=await resolvePages(f.env,f.api);
  assert.equal(r.mode,"release-set");assert.equal(r.tag,"");assert.equal(r["latest-id"],"");assert.equal(r.repository,"upstream/app");
  assert.equal(r["site-artifact-id"],"9");assert.equal(r["site-head-sha"],"b".repeat(40));
  assert.deepEqual(f.api.calls,["repos/owner/example/actions/artifacts/9","repos/owner/example/actions/runs/20"]);
  for(const bad of [{INPUT_TAG:"v1.0.0"},{"INPUT_ARTIFACT-ID":"9"}])await assert.rejects(resolvePages({...f.env,...bad},f.api),/cannot be combined/);
  await assert.rejects(resolvePages({...f.env,INPUT_CONFIG:"",INPUT_FILES:"a"},f.api),/requires a release-set/);
});
test("documentation artifact wrong repo/run/SHA/expiry/digest/size is rejected before extraction",async t=>{
  const f=await fixture(t),original=structuredClone(f.api.artifact);
  for(const mutate of [a=>{a.expired=true;},a=>{a.workflow_run.repository_id=8;},a=>{a.workflow_run.id=21;},a=>{a.workflow_run.head_sha="e".repeat(40);},a=>{a.digest="bad";},a=>{a.size_in_bytes=2*1024**3+1;}]){
    f.api.artifact=structuredClone(original);mutate(f.api.artifact);
    await assert.rejects(resolvePages(f.env,f.api),/Artifact/);
  }
  for(const id of ["0","-1","1e2","9007199254740993"])await assert.rejects(resolvePages({...f.env,"INPUT_SITE-ARTIFACT-ID":id},f.api),/artifact-id/);
});
test("mixed preparation and delivery retain releases, documentation provenance, hidden files and generated identity",async t=>{
  const f=await prepare(t),out=await finalizePages(f.finalEnv),r=await loadReport(out.report,out["report-sha"]);
  assert.equal(r.schema,2);assert.equal(r.source.kind,"github-release-set");assert.equal(r.source.repository,"upstream/app");
  assert.equal(r.baseline.kind,"workflow-artifact");assert.equal(r.baseline.repository,"owner/example");assert.equal(r.baseline.artifactId,"9");
  assert.equal(r.baseline.headSha,"b".repeat(40));assert.equal(r.baseline.callerSha,"a".repeat(40));assert.equal(r.baseline.artifactDigest,f.api.artifact.digest);
  assert.equal(r.files.find(f=>f.path===".nojekyll").generatedBy,"pages");
  assert.ok(r.files.some(f=>f.path===".well-known/info.json"));assert.equal(r.contentDigest,f.core.digest);
  assert.equal(await readFile(join(f.core.path,"policy.json"),"utf8"),"untrusted artifact policy is never read");
  const guarded={...f.env,INPUT_REPORT:out.report,"INPUT_REPORT-SHA":out["report-sha"]};
  await guardPages(guarded,f.api);
  f.api.records[0].commit="e".repeat(40);await assert.rejects(guardPages(guarded,f.api),/changed/);
});
test("release-set guard catches a new matching version before and after served verification",async t=>{
  const f=await prepare(t),out=await finalizePages(f.finalEnv);
  const env={...f.env,INPUT_REPORT:out.report,"INPUT_REPORT-SHA":out["report-sha"]};
  const newer={id:6,tag_name:"v1.1.0",draft:false,prerelease:false,immutable:true,commit:"e".repeat(40)};
  f.api.records.push({...newer,tag_name:"v3.0.0"});await guardPages(env,f.api);f.api.records.pop();
  f.api.records.push(newer);await assert.rejects(guardPages(env,f.api),/superseded/);f.api.records.pop();
  let changed=false;
  t.mock.method(globalThis,"fetch",async url=>{
    const path=new URL(url).pathname.replace(/^\/site\//,"").split("/").map(decodeURIComponent).join("/");
    const bytes=await readFile(join(f.core.path,path));
    if(!changed){changed=true;f.api.records.push(newer);}
    return new Response(bytes,{status:200});
  });
  await assert.rejects(runPages({...env,INPUT_OPERATION:"verify","INPUT_PAGE-URL":"https://example.test/site/"},f.api),/superseded/);
});
test("mixed finalization rejects lost or overwritten artifact provenance",async t=>{
  for(const bad of [{"INPUT_SITE-ARTIFACT-DIGEST":"bad"},{"INPUT_SITE-HEAD-SHA":""},{"INPUT_ARTIFACT-ID":"9"}]){
    const f=await prepare(t);await assert.rejects(finalizePages({...f.finalEnv,...bad}),/provenance|identity/);
  }
  const f=await fixture(t);
  await assert.rejects(runPages({...f.env,INPUT_OPERATION:"prepare","INPUT_SITE-PATH":f.site,"INPUT_SOURCE-PATH":f.site},f.api),/no source artifact/);
  await assert.rejects(runPages({...f.env,INPUT_OPERATION:"prepare","INPUT_SOURCE-PATH":f.site},f.api),/no source artifact/);
});
test("mixed report and actual Pages tar preserve identical membership",{skip:process.platform!=="linux"},async t=>{
  const f=await prepare(t),out=await finalizePages(f.finalEnv);
  execFileSync("tar",["-cf",join(f.env.RUNNER_TEMP,"artifact.tar"),"-C",f.core.path,"."]);
  await checkArchive({...f.env,INPUT_REPORT:out.report,"INPUT_REPORT-SHA":out["report-sha"]});
});
test("reusable workflow resolves checked-out policy and keeps separate exact source/site artifact wiring",async()=>{
  const flow=parse(await readFile(new URL("../.github/workflows/distribute-pages.yml",import.meta.url),"utf8"));
  const steps=flow.jobs.prepare.steps;
  assert.ok(steps.findIndex(s=>s.name==="Checkout caller policy")<steps.findIndex(s=>s.id==="resolve"));
  const download=steps.find(s=>s.name==="Download documentation artifact");assert.equal(download.with["digest-mismatch"],"error");
  assert.equal(download.with["artifact-ids"],"${{ steps.resolve.outputs.site-artifact-id }}");
  const final=steps.find(s=>s.id==="finalize");assert.equal(final.with["site-artifact-digest"],"${{ steps.resolve.outputs.site-artifact-digest }}");
  assert.equal(flow.on.workflow_call.inputs["site-artifact-id"].default,"");
});
