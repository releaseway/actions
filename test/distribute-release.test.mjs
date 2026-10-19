import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import test from "node:test";
import { distribute } from "../src/distribution/action.ts";
import { GhClient } from "../src/distribution/gh.ts";
const commit = "a".repeat(40);
const sha = bytes => "sha256:"+createHash("sha256").update(bytes).digest("hex");
async function fixture(t, overrides={}) {
  const dir=await mkdtemp(join(tmpdir(),"release-source-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  for (const p of ["work","temp"]) await mkdir(join(dir,p));
  const env={GITHUB_WORKSPACE:join(dir,"work"),RUNNER_TEMP:join(dir,"temp"),GITHUB_OUTPUT:join(dir,"output"),GITHUB_REPOSITORY:"owner/example",INPUT_TAG:"v1/with space",INPUT_FILES:"install.sh",...overrides};
  await writeFile(env.GITHUB_OUTPUT,"");
  return {env,dir};
}
function api(options={}) {
  const bytes=Buffer.from("#!/bin/sh\r\necho hi\r\n");
  const assets=options.assets??[{id:7,name:"install.sh",size:bytes.length,state:"uploaded",digest:sha(bytes)}];
  const calls=[]; let snapshots=0;
  return {calls,bytes,
    async json(endpoint) {
      calls.push(endpoint);
      if(endpoint==="repos/owner/example")return {private:options.private??false};
      if(endpoint.includes("/releases/tags/")){snapshots++;return {id:20,tag_name:"v1/with space",draft:options.draft??false,prerelease:true,immutable:options.immutable??false};}
      if(endpoint.includes("/git/ref/"))return {object:{type:options.annotated?"tag":"commit",sha:options.move&&snapshots>1?"b".repeat(40):commit}};
      if(endpoint.includes("/git/tags/"))return {object:{type:"commit",sha:commit}};
      if(endpoint.includes("/assets?"))return options.changed&&snapshots>1?assets.map(a=>({...a,id:a.id+1})):assets;
      throw new Error("unexpected endpoint "+endpoint);
    },
    async download(endpoint,path,maximum){calls.push(endpoint);assert.equal(maximum,bytes.length);await writeFile(path,options.corrupt?"wrong":bytes);},
    async verify(tag,path,repository){calls.push("attested");assert.equal(tag,"v1/with space");assert.equal(repository,"owner/example");assert.deepEqual(await readFile(path),bytes);if(options.noAttestation)throw new Error("No attestation capability");}
  };
}
test("exact public Release matches local bytes, peels annotated tags and records snapshot provenance",async t=>{
 const f=await fixture(t,{INPUT_COMMIT:commit});const gh=api({annotated:true});
 const result=await distribute(f.env,gh);assert.deepEqual(await readFile(join(result.path,"install.sh")),gh.bytes);
 const report=JSON.parse(await readFile(result.report));assert.equal(report.source.commit,commit);assert.equal(report.source.verification,"digest");assert.equal(report.source.immutable,false);
 assert.ok(gh.calls.includes("repos/owner/example/releases/assets/7"));assert.ok(gh.calls.includes("repos/owner/example/releases/tags/v1%2Fwith%20space"));
 assert.deepEqual((await readdir(f.env.RUNNER_TEMP)).filter(s=>s.startsWith("releaseway-source-")),[]);
});
test("attested mode verifies exact downloaded bytes and never downgrades",async t=>{
 const f=await fixture(t,{INPUT_VERIFICATION:"attested"});const good=api();await distribute(f.env,good);assert.ok(good.calls.includes("attested"));
 const g=await fixture(t,{INPUT_VERIFICATION:"attested"});await assert.rejects(distribute(g.env,api({noAttestation:true})),/attestation/);assert.equal(await readFile(g.env.GITHUB_OUTPUT,"utf8"),"");assert.deepEqual(await readdir(g.env.RUNNER_TEMP),[]);
});
test("missing digest, mutable snapshots, wrong commit, private/draft and tampering fail before output",async t=>{
 for(const cfg of [{private:true},{draft:true},{move:true},{changed:true},{corrupt:true},{assets:[{id:7,name:"install.sh",size:1,state:"uploaded",digest:null}]}]){
  const f=await fixture(t);await assert.rejects(distribute(f.env,api(cfg)));assert.equal(await readFile(f.env.GITHUB_OUTPUT,"utf8"),"");assert.deepEqual(await readdir(f.env.RUNNER_TEMP),[]);
 }
 const f=await fixture(t,{INPUT_COMMIT:"b".repeat(40)});await assert.rejects(distribute(f.env,api()),/commit/);
});
test("remote-only flags cannot silently change local semantics",async t=>{
 const f=await fixture(t,{INPUT_TAG:"",INPUT_REPOSITORY:"owner/example"});await assert.rejects(distribute(f.env),/require tag/);
 const g=await fixture(t,{INPUT_ROOT:"dist"});await assert.rejects(distribute(g.env,api()),/local/);
});
test("gh subprocess fixes host/token, bounds output, times out and redacts raw errors",async t=>{
 const f=await fixture(t);const script=join(f.dir,"gh-fake.cjs");
 await writeFile(script,`if(process.argv.includes('slow'))setTimeout(()=>{},10000);else if(process.argv.includes('bad')){console.error('secret-token https://example?token=secret');process.exit(1)}else console.log(JSON.stringify({args:process.argv.slice(2),host:process.env.GH_HOST,token:process.env.GH_TOKEN}));`);
 const gh=new GhClient("provided-token",join(f.dir,"cache"),Date.now()+5000,{},process.execPath,[script]);
 const got=await gh.json("repos/owner/example");assert.equal(got.host,"github.com");assert.equal(got.token,"provided-token");assert.deepEqual(got.args.slice(0,3),["api","--hostname","github.com"]);
 await assert.rejects(gh.json("bad"),e=>!e.message.includes("secret"));
 await assert.rejects(new GhClient("x",join(f.dir,"cache"),Date.now()+30,{},process.execPath,[script]).json("slow"),/failed/);
 assert.throws(()=>new GhClient("",f.dir),/token/);
});


test("asset pagination includes later pages and duplicate names fail closed",async t=>{
 const f=await fixture(t);const gh=api();const json=gh.json.bind(gh);const other=Array.from({length:100},(_,i)=>({id:100+i,name:`other-${i}.txt`,size:0,state:"uploaded",digest:sha("")}));
 gh.json=async e=>e.includes("/assets?")?(e.endsWith("page=1")?other:[{id:7,name:"install.sh",size:gh.bytes.length,state:"uploaded",digest:sha(gh.bytes)}]):json(e);
 await distribute(f.env,gh);
 const g=await fixture(t);const duplicate={id:7,name:"install.sh",size:gh.bytes.length,state:"uploaded",digest:sha(gh.bytes)};
 await assert.rejects(distribute(g.env,api({assets:[duplicate,{...duplicate,id:8}]})),/Duplicate/);
 assert.equal(await readFile(g.env.GITHUB_OUTPUT,"utf8"),"");
});

test("missing token and oversize subprocess output leave no action result",async t=>{
 const f=await fixture(t);await assert.rejects(distribute(f.env),/token/);assert.deepEqual(await readdir(f.env.RUNNER_TEMP),[]);
 const script=join(f.dir,"large.cjs");await writeFile(script,'process.stdout.write(Buffer.alloc(2048))');
 const gh=new GhClient("x",f.dir,Date.now()+5000,{},process.execPath,[script]);
 await assert.rejects(gh.download("asset",join(f.dir,"partial"),10),/byte limit/);
});
