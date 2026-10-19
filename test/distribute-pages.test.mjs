import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
import { distribute } from "../src/distribution/action.ts";
import { resolvePages,finalizePages,loadReport,guardPages,checkArchive,environmentDeployment,runPages } from "../src/distribution/pages.ts";
import { verifyServed } from "../src/distribution/verify-served.ts";
const hash=b=>createHash("sha256").update(b).digest("hex");
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),"pages-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,"work"));await mkdir(join(dir,"temp"));return {dir,env:{GITHUB_WORKSPACE:join(dir,"work"),RUNNER_TEMP:join(dir,"temp"),GITHUB_SERVER_URL:"https://github.com",GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_RUN_ID:"20",GITHUB_RUN_ATTEMPT:"1",GITHUB_REPOSITORY:"owner/example",GITHUB_REPOSITORY_ID:"7",GITHUB_SHA:"a".repeat(40),INPUT_FILES:"install.sh"}};}
test("Pages defaults to latest under lock, requires trusted event and source XOR, and names invocations uniquely",async t=>{
 const {env}=await fixture(t);const gh={async json(){return {id:5,tag_name:"v1",draft:false,prerelease:false};}};
 const a=await resolvePages(env,gh),b=await resolvePages(env,gh);assert.equal(a.tag,"v1");assert.equal(a["latest-id"],"5");assert.notEqual(a["artifact-name"],b["artifact-name"]);
 await assert.rejects(resolvePages({...env,INPUT_TAG:"v1","INPUT_ARTIFACT-ID":"1"},gh),/not both/);
 for(const event of ["pull_request","pull_request_target","merge_group"])await assert.rejects(resolvePages({...env,GITHUB_EVENT_NAME:event},gh),/trusted/);
});
test("artifact source checks repository/run head SHA and expiry independently of caller merge SHA",async t=>{
 const {env}=await fixture(t);let artifact={id:9,expired:false,size_in_bytes:25,digest:"sha256:"+"c".repeat(64),workflow_run:{id:20,repository_id:7,head_sha:"b".repeat(40)}};
 const gh={async json(e){return e.includes("/artifacts/")?artifact:{head_sha:"b".repeat(40)};}};
 const r=await resolvePages({...env,"INPUT_ARTIFACT-ID":"9"},gh);assert.equal(r.tag,"");assert.equal(r["artifact-id"],"9");
 artifact={...artifact,expired:true};await assert.rejects(resolvePages({...env,"INPUT_ARTIFACT-ID":"9"},gh),/expired/);
 artifact={...artifact,expired:false,workflow_run:{...artifact.workflow_run,id:21}};await assert.rejects(resolvePages({...env,"INPUT_ARTIFACT-ID":"9"},gh),/run/);
});
test("Pages delivery includes .nojekyll and explicit .well-known files while report tampering fails",async t=>{
 const {env}=await fixture(t);await mkdir(join(env.GITHUB_WORKSPACE,".well-known"));await writeFile(join(env.GITHUB_WORKSPACE,".well-known/data.json"),"{}");
 const core=await distribute({...env,INPUT_FILES:".well-known/data.json",INPUT_ROOT:"."});
 const result=await finalizePages({...env,INPUT_PATH:core.path,INPUT_REPORT:core.report});const report=await loadReport(result.report,result["report-sha"]);
 assert.equal(report.contentDigest,core.digest);assert.ok(report.files.some(f=>f.path===".nojekyll"));assert.ok(report.files.some(f=>f.path===".well-known/data.json"));
 const gh={async json(){throw new Error("exact/artifact mode must not query latest");}};
 await guardPages({...env,INPUT_REPORT:result.report,"INPUT_REPORT-SHA":result["report-sha"]},gh);
 await writeFile(result.report,"{}");await assert.rejects(loadReport(result.report,result["report-sha"]),/hash/);
});
test("latest supersession, forbidden package exclusions and nonempty .nojekyll stop delivery",async t=>{
 const {env}=await fixture(t);await writeFile(join(env.GITHUB_WORKSPACE,"install.sh"),"echo hi");
 const core=await distribute(env);await assert.rejects(finalizePages({...env,INPUT_PATH:core.path,INPUT_REPORT:core.report,"INPUT_LATEST-ID":"99"}),/Latest/);
 await writeFile(join(env.GITHUB_WORKSPACE,".nojekyll"),"nonempty");const bad=await distribute({...env,INPUT_FILES:".nojekyll"});await assert.rejects(finalizePages({...env,INPUT_PATH:bad.path,INPUT_REPORT:bad.report}),/Nonempty/);
 await mkdir(join(env.GITHUB_WORKSPACE,".github"));await writeFile(join(env.GITHUB_WORKSPACE,".github/info"),"x");const excluded=await distribute({...env,INPUT_FILES:".github/info",INPUT_ROOT:"."});await assert.rejects(finalizePages({...env,INPUT_PATH:excluded.path,INPUT_REPORT:excluded.report}),/excludes/);
});
test("served verifier encodes paths and retries cache without leaving origin/base or accepting excess bytes",async()=>{
 const bytes=Buffer.from("hi"),files=[{path:"한국어 #%.sh",size:2,sha256:hash(bytes),origin:"selected"}];let requests=0;
 await verifyServed("https://example.test/base/",files,async(url,options)=>{assert.ok(String(url).startsWith("https://example.test/base/%"));assert.ok(String(url).includes("%23%25"));assert.equal(options.redirect,"manual");requests++;return new Response(bytes,{status:200});});assert.equal(requests,1);
 await assert.rejects(verifyServed("https://example.test/base/",files,async()=>new Response(null,{status:302,headers:{location:"https://other.test/x"}})),/Redirect/);
 await assert.rejects(verifyServed("https://example.test/base/",files,async()=>new Response("too much")),/exceeds/);
 await assert.rejects(verifyServed("https://example.test/base/",files,async()=>new Response("no",{status:404}),Date.now()+10),/deadline/);
});
test("environment deployment ID must match exact consumer run/job status URL",async t=>{
 const {env}=await fixture(t);const gh={async json(e){return e.includes("/statuses")?[{log_url:"https://github.com/owner/example/actions/runs/20/job/44"}]:[{id:555,environment:"github-pages",sha:env.GITHUB_SHA}];}};
 assert.equal(await environmentDeployment({...env,"INPUT_CHECK-RUN-ID":"44"},gh),"555");await assert.rejects(environmentDeployment({...env,"INPUT_CHECK-RUN-ID":"45"},gh),/No environment/);
});
test("archive inventory must match delivery report and preserve hidden members",{skip:process.platform!=="linux"},async t=>{
 const {env}=await fixture(t);await writeFile(join(env.GITHUB_WORKSPACE,"install.sh"),"ok");const core=await distribute(env);const final=await finalizePages({...env,INPUT_PATH:core.path,INPUT_REPORT:core.report});
 execFileSync("tar",["-cf",join(env.RUNNER_TEMP,"artifact.tar"),"-C",core.path,"."]);
 await checkArchive({...env,INPUT_REPORT:final.report,"INPUT_REPORT-SHA":final["report-sha"]});
 await writeFile(join(core.path,"extra"),"wrong");execFileSync("tar",["-cf",join(env.RUNNER_TEMP,"artifact.tar"),"-C",core.path,"."]);
 await assert.rejects(checkArchive({...env,INPUT_REPORT:final.report,"INPUT_REPORT-SHA":final["report-sha"]}),/membership/);
});
test("reusable workflow keeps role separation, exact artifacts, static local uses and complete output contract",async()=>{
 const flow=parse(await readFile(new URL("../.github/workflows/distribute-pages.yml",import.meta.url),"utf8"));
 assert.equal(flow.concurrency.group,"pages");assert.equal(flow.concurrency["cancel-in-progress"],false);
 assert.equal(flow.jobs.prepare.permissions.actions,"read");assert.equal(flow.jobs.prepare.permissions.pages,undefined);assert.equal(flow.jobs.deploy.permissions.pages,"write");assert.equal(flow.jobs.deploy.permissions["id-token"],"write");
 const pack=flow.jobs.prepare.steps.find(s=>s.uses?.startsWith("actions/upload-pages-artifact@"));assert.equal(pack.with["include-hidden-files"],true);
 const deploy=flow.jobs.deploy.steps.find(s=>s.id==="deploy");assert.equal(deploy.with.artifact_name,"${{ needs.prepare.outputs.artifact-name }}");
 for(const job of Object.values(flow.jobs))for(const step of job.steps)if(step.uses)assert.ok(step.uses.startsWith("./automation/")||/@[0-9a-f]{40}$/.test(step.uses));
 assert.equal(Object.keys(flow.on.workflow_call.outputs).length,5);
});


test("latest guard rejects supersession against the exact report artifact",async t=>{
 const {env}=await fixture(t);await writeFile(join(env.GITHUB_WORKSPACE,"install.sh"),"ok");const core=await distribute(env);const final=await finalizePages({...env,INPUT_PATH:core.path,INPUT_REPORT:core.report});
 const r=JSON.parse(await readFile(final.report,"utf8"));r.latestId="5";r.source={kind:"github-release",repository:"owner/example",releaseId:5};const bytes=JSON.stringify(r);await writeFile(final.report,bytes);
 const guarded={...env,INPUT_REPORT:final.report,"INPUT_REPORT-SHA":hash(bytes)};
 await guardPages(guarded,{async json(){return{id:5,tag_name:"v1",draft:false,prerelease:false}}});
 await assert.rejects(guardPages(guarded,{async json(){return{id:6,tag_name:"v2",draft:false,prerelease:false}}}),/superseded/);
});

test("served verifier retries a stale cache within the overall deadline",async()=>{
 let attempts=0;const bytes=Buffer.from("ok");
 await verifyServed("https://example.test/base",[{path:"install.sh",size:2,sha256:hash(bytes),origin:"selected"}],async()=>new Response(++attempts===1?"no":bytes),Date.now()+2500);
 assert.equal(attempts,2);
});


test("internal artifact preparation reads caller config outside payload and applies implicit public root",async t=>{
 const {env}=await fixture(t);const payload=join(env.RUNNER_TEMP,"artifact");await mkdir(join(payload,"dist"),{recursive:true});await writeFile(join(payload,"dist/install.sh"),"ok");
 await mkdir(join(env.GITHUB_WORKSPACE,"source"));await writeFile(join(env.GITHUB_WORKSPACE,"source/policy.yml"),'schema: 1\nfiles: [{from: dist/install.sh, to: install.sh}]');
 const r=await runPages({...env,INPUT_OPERATION:"prepare",INPUT_FILES:"",INPUT_CONFIG:"source/policy.yml","INPUT_SOURCE-PATH":payload,INPUT_TOKEN:"test"});
 assert.equal(await readFile(join(r.path,"install.sh"),"utf8"),"ok");
 const glob=await runPages({...env,INPUT_OPERATION:"prepare",INPUT_FILES:"dist/*","INPUT_SOURCE-PATH":payload,INPUT_TOKEN:"test"});
 assert.equal(await readFile(join(glob.path,"install.sh"),"utf8"),"ok");
});
