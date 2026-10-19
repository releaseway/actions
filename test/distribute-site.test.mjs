import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm,chmod,stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { distribute } from "../src/distribution/action.ts";
async function setup(t){const dir=await mkdtemp(join(tmpdir(),"site-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));for(const p of ["work","temp"])await mkdir(join(dir,p));return {dir,env:{GITHUB_WORKSPACE:join(dir,"work"),RUNNER_TEMP:join(dir,"temp")}};}
async function put(root,path,bytes){const f=join(root,path);await mkdir(join(f,".."),{recursive:true});await writeFile(f,bytes);return f;}
async function inventory(r){return JSON.parse(await readFile(r.report,"utf8"));}
test("optional config renames exact literal metacharacters; root affects only source resolution",async t=>{
 const {env}=await setup(t);await put(env.GITHUB_WORKSPACE,"dist/[custom] installer.sh","abc\r\n");
 await put(env.GITHUB_WORKSPACE,"policy.yml","schema: 1\nfiles:\n  - from: '[custom] installer.sh'\n    to: install.sh\n");
 const r=await distribute({...env,INPUT_CONFIG:"policy.yml",INPUT_ROOT:"dist",INPUT_DESTINATION:"tools/a/v1"});
 assert.equal(await readFile(join(r.path,"tools/a/v1/install.sh"),"utf8"),"abc\r\n");assert.equal((await inventory(r)).files.length,1);
});
test("sequential outputs preserve two products, versions, channels and unrelated site bytes",async t=>{
 const {env}=await setup(t);await put(env.GITHUB_WORKSPACE,"site/docs/index.html","docs");await put(env.GITHUB_WORKSPACE,"site/.well-known/info.json","{}");
 let site=join(env.GITHUB_WORKSPACE,"site");
 for(const product of ["a","b"])for(const version of ["v1","v2"])for(const channel of ["stable","beta"]){
  await put(env.GITHUB_WORKSPACE,"generated/install.sh",`${product}-${version}-${channel}`);
  const r=await distribute({...env,INPUT_FILES:"generated/install.sh",INPUT_SITE:site,INPUT_DESTINATION:`${product}/${version}/${channel}`});site=r.path;
 }
 assert.equal(await readFile(join(site,"docs/index.html"),"utf8"),"docs");assert.equal(await readFile(join(site,".well-known/info.json"),"utf8"),"{}");
 assert.equal(await readFile(join(site,"b/v2/beta/install.sh"),"utf8"),"b-v2-beta");
 assert.equal(await readFile(join(env.GITHUB_WORKSPACE,"site/docs/index.html"),"utf8"),"docs");
 assert.equal((await readdir(join(env.GITHUB_WORKSPACE,"site"))).length,2);
});
test("default conflicts preserve original site; replace changes selected target only",async t=>{
 const {env}=await setup(t);await put(env.GITHUB_WORKSPACE,"site/install.sh","old");await put(env.GITHUB_WORKSPACE,"site/other.json","keep");await put(env.GITHUB_WORKSPACE,"dist/install.sh","new");
 await assert.rejects(distribute({...env,INPUT_FILES:"dist/install.sh",INPUT_SITE:"site"}),/conflicts/);assert.deepEqual(await readdir(env.RUNNER_TEMP),[]);
 const r=await distribute({...env,INPUT_FILES:"dist/install.sh",INPUT_SITE:"site",INPUT_CONFLICT:"replace"});
 assert.equal(await readFile(join(r.path,"install.sh"),"utf8"),"new");assert.equal(await readFile(join(r.path,"other.json"),"utf8"),"keep");assert.equal(await readFile(join(env.GITHUB_WORKSPACE,"site/install.sh"),"utf8"),"old");
});
test("source inside baseline is valid; identical selected content retains local execute bits",async t=>{
 const {env}=await setup(t);const source=await put(env.GITHUB_WORKSPACE,"site/install.sh","same");await chmod(source,0o755);
 const r=await distribute({...env,INPUT_FILES:"site/install.sh",INPUT_SITE:"site"});assert.equal(await readFile(join(r.path,"install.sh"),"utf8"),"same");
 if(process.platform!=="win32")assert.equal((await stat(join(r.path,"install.sh"))).mode&0o111,0o111);
 assert.equal((await inventory(r)).files[0].origin,"selected");
});
test("strict config errors reject duplicate/unknown/alias/type/path/target ambiguity",async t=>{
 const {env}=await setup(t);await put(env.GITHUB_WORKSPACE,"a","a");
 for(const text of [
 'schema: 1\nschema: 1\nfiles: []',
 '{"schema":1,"schema":1,"files":[]}',
 'schema: 1\nunknown: true\nfiles: []',
 'schema: 1\nfiles: &mapping []',
 'schema: 1\nfiles: [{from: null,to: x}]',
 'schema: 1\nfiles: [{from: ../a,to: x}]',
 'schema: 1\nfiles: [{from: a,to: A},{from: a,to: a}]',
 'schema: 1\nfiles: [{from: a,to: x},{from: a,to: x/y}]'
 ]){await put(env.GITHUB_WORKSPACE,"config.yml",text);await assert.rejects(distribute({...env,INPUT_CONFIG:"config.yml"}));assert.deepEqual(await readdir(env.RUNNER_TEMP),[]);}
 await assert.rejects(distribute({...env,INPUT_CONFIG:"config.yml",INPUT_FILES:"a"}),/exactly one/);
});
test("baseline portable and file/ancestor conflicts never mutate supplied site",async t=>{
 const {env}=await setup(t);await put(env.GITHUB_WORKSPACE,"site/Readme","original");await put(env.GITHUB_WORKSPACE,"dist/readme","selected");
 await assert.rejects(distribute({...env,INPUT_FILES:"dist/readme",INPUT_SITE:"site"}),/Duplicate/);
 assert.equal(await readFile(join(env.GITHUB_WORKSPACE,"site/Readme"),"utf8"),"original");assert.deepEqual(await readdir(env.RUNNER_TEMP),[]);
});


test("explicit replace applies limits to final output without copying discarded baseline content",async t=>{
 const {env}=await setup(t);await put(env.GITHUB_WORKSPACE,"site/install.sh","oversized discarded bytes");await put(env.GITHUB_WORKSPACE,"dist/install.sh","ok");
 const r=await distribute({...env,INPUT_FILES:"dist/install.sh",INPUT_SITE:"site",INPUT_CONFLICT:"replace","INPUT_MAX-FILE-BYTES":"2","INPUT_MAX-TOTAL-BYTES":"2"});
 assert.equal(await readFile(join(r.path,"install.sh"),"utf8"),"ok");assert.equal(await readFile(join(env.GITHUB_WORKSPACE,"site/install.sh"),"utf8"),"oversized discarded bytes");
});
