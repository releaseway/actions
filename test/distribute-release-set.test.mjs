import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseConfig, readConfig } from "../src/distribution/config.ts";
import { releaseInventory, selectReleases, discoverReleaseSet, selectAssets, prepareReleaseSet } from "../src/distribution/release-set.ts";
import { options } from "../src/distribution/inputs.ts";
import { GhClient } from "../src/distribution/gh.ts";
import { distribute } from "../src/distribution/action.ts";
import { contentDigest, reportShape } from "../src/distribution/report.ts";

const config = overrides => parseConfig({schema:2,releases:{"tag-prefix":"v",range:">=1.0.0 <2.0.0"},files:[{from:"installer.sh",to:"install.sh"}],...overrides});
const summary = (tag,id,pre=false,draft=false) => ({tag,id,prerelease:pre,draft,immutable:true});
const wire = r => ({id:r.id,tag_name:r.tag,prerelease:r.prerelease,draft:r.draft,immutable:r.immutable});
const asset = (name="installer.sh",id=1) => ({name,id,state:"uploaded",size:2,digest:"sha256:"+createHash("sha256").update("ok").digest("hex")});

test("strict config v1 stays exact while v2 normalizes selectors and required defaults",async t=>{
  assert.deepEqual(parseConfig({schema:1,files:[{from:"dist/a [x]",to:"a"}]}),{schema:1,files:[{from:"dist/a [x]",to:"a"}]});
  const c=config({releases:{tags:["v2","v1"],"on-empty":"skip"}});
  assert.deepEqual(c.releases,{tags:["v1","v2"],onEmpty:"skip"});
  assert.deepEqual(c.files,[{from:"installer.sh",to:"install.sh",required:true}]);
  const root=await mkdtemp(join(tmpdir(),"release-set-config-"));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const invalid of ['schema: 2\nschema: 1\nfiles: []','schema: 2\nreleases: &r {tags: [v1]}\nfiles: *r']) {
    await writeFile(join(root,"config.yml"),invalid);
    await assert.rejects(readConfig(root,"config.yml"),/strict/);
  }
});
test("schema2 rejects ambiguous/null/unknown policy, optional-only and invalid aliases",()=>{
  for(const releases of [{tags:[]},{tags:["v1","v1"]},{tags:["../v1"]},{tags:["v1"],range:"*"},{"tag-prefix":"v",range:"invalid"},{range:"*"},{tags:["v1"],"on-empty":null},{"tag-prefix":"v",range:"*","include-prereleases":null}])assert.throws(()=>config({releases}));
  for(const files of [[{from:"a",to:"a",required:false}],[{from:"dist/a",to:"a"}],[{from:"a",to:"a",required:null}],[{from:"a",to:"A"},{from:"b",to:"a"}]])assert.throws(()=>config({files}));
  for(const aliases of [null,{}, {tag:"v1",select:"highest-stable",files:[{from:"install.sh",to:"install.sh"}]},{select:"latest",files:[{from:"install.sh",to:"install.sh"}]},{tag:"v1",files:[{from:"missing",to:"install.sh"}]}])assert.throws(()=>config({aliases}));
  assert.throws(()=>config({releases:{tags:["v1"]},aliases:{select:"highest-stable",files:[{from:"install.sh",to:"install.sh"}]}}));
  assert.throws(()=>parseConfig({schema:1,releases:{tags:["v1"]},files:[{from:"a",to:"a"}]}),/Unknown/);
});
test("range selection sorts SemVer, excludes sidecars/build metadata and separates prerelease flags",()=>{
  const items=[summary("v1.9.0",1),summary("v1.10.0",2),summary("v1.11.0",3,true),summary("v1.12.0-beta.1",4),summary("evidence-v1.0.0",5),summary("v1.8.0+build",6),summary("v2.0.0",7),summary("v1.13.0",8,false,true)];
  const c=config({aliases:{select:"highest-stable",files:[{from:"install.sh",to:"install.sh"}]}});
  assert.deepEqual(selectReleases(c,items).releases.map(r=>r.tag),["v1.9.0","v1.10.0"]);
  const pre=config({releases:{"tag-prefix":"v",range:">=1.0.0 <2.0.0","include-prereleases":true},aliases:c.aliases});
  const result=selectReleases(pre,items);
  assert.deepEqual(result.releases.map(r=>r.tag),["v1.9.0","v1.10.0","v1.11.0","v1.12.0-beta.1"]);
  assert.equal(result.alias.tag,"v1.10.0");
  assert.throws(()=>selectReleases(c,[summary("v1.1.0-beta.1",1)]),/No matching/);
  assert.throws(()=>selectReleases(c,[summary("v1.1.0",1,true)]),/No matching/);
});
test("explicit tags select prereleases and validate exact alias/path membership",()=>{
  const c=config({releases:{tags:["product/v1"]},aliases:{tag:"product/v1",files:[{from:"install.sh",to:"install.sh"}]}});
  assert.equal(selectReleases(c,[summary("product/v1",1,true)]).alias.tag,"product/v1");
  assert.throws(()=>selectReleases(c,[]),/missing/);
  assert.throws(()=>selectReleases(c,[summary("product/v1",1,false,true)]),/draft/);
  assert.throws(()=>selectReleases(config({releases:{tags:["product/v1"]},aliases:{...c.aliases,tag:"other"}}),[summary("product/v1",1)]),/Alias/);
  assert.throws(()=>selectReleases(config({releases:{"tag-prefix":"",range:"*"},aliases:{tag:"1.0.0",files:[{from:"install.sh",to:"1.0.0/install.sh"}]}}),[summary("1.0.0",1)]),/Duplicate/);
});
test("empty/partial/optional assets differ and invalid existing assets never become skipped",()=>{
  const c=config({releases:{tags:["v1"],"on-empty":"skip"},files:[{from:"installer.sh",to:"install.sh"},{from:"other",to:"optional",required:false}]});
  assert.equal(selectAssets(c,[asset("unrelated")],100).status,"skipped-empty");
  assert.throws(()=>selectAssets(c,[asset("other")],100),/required/);
  assert.equal(selectAssets(c,[asset()],100).files.length,1);
  for(const bad of [{...asset(),digest:null},{...asset(),size:101},{...asset(),state:"new"},{...asset(),id:true}])assert.throws(()=>selectAssets(c,[bad],100));
  assert.throws(()=>selectAssets(c,[asset(),asset("installer.sh",2)],100),/Duplicate/);
  const rename=config({files:[{from:"installer.sh",to:"a"},{from:"installer.sh",to:"b"}]});
  assert.equal(selectAssets(rename,[asset()],100).assets.length,1);
  assert.equal(selectAssets(rename,[asset()],100).files.length,2);
  assert.throws(()=>selectAssets(config(),[],100),/no configured/);
});
test("release inventory handles 0/100/101 entries, projects metadata and rejects incomplete/malformed pages",async()=>{
  for(const count of [0,100,101]) {
    const items=Array.from({length:count},(_,i)=>wire(summary(`v1.0.${i}`,i+1)));
    const pages=[];const gh={async json(endpoint,projection){assert.match(projection,/tag_name/);assert.ok(!projection.includes("body"));const page=Number(new URL(endpoint,"https://api.github.com/").searchParams.get("page"));pages.push(page);return items.slice((page-1)*100,page*100);}};
    assert.equal((await releaseInventory(gh,"owner/repo")).length,count);
    assert.deepEqual(pages,count>=100?[1,2]:[1]);
  }
  for(const invalid of [{},[null],[{id:1,tag_name:"v1",draft:"false",prerelease:false}],Array.from({length:101},()=>wire(summary("v1",1)))])await assert.rejects(releaseInventory({async json(){return invalid;}},"owner/repo"));
  await assert.rejects(releaseInventory({async json(){return [wire(summary("v1",1)),wire(summary("v1",2))];}},"owner/repo"),/Duplicate/);
  await assert.rejects(releaseInventory({async json(endpoint){const page=Number(new URL(endpoint,"https://api.github.com/").searchParams.get("page"));return Array.from({length:100},(_,i)=>wire(summary(`v1.0.${page*100+i}`,page*100+i)));}},"owner/repo"),/pagination/);
  await assert.rejects(discoverReleaseSet({async json(){return {private:true};}},"owner/repo",config()),/public/);
});
test("real gh projection drops large release bodies before Node receives the response",async t=>{
  const root=await mkdtemp(join(tmpdir(),"release-set-projection-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=join(root,"transport.cjs");
  await writeFile(fixture,`const http=require('node:http');const values=[{id:1,tag_name:'v1.0.0',draft:false,prerelease:false,immutable:true,body:'x'.repeat(20*1024*1024)}];const server=http.createServer((_q,r)=>{r.end(JSON.stringify(values));});server.listen(0,'127.0.0.1',()=>{const args=process.argv.slice(2);const port=server.address().port;const child=require('node:child_process').spawn('gh',['api','--hostname','github.com','--jq',args[args.indexOf('--jq')+1], 'http://127.0.0.1:'+port+'/releases'],{stdio:['ignore','pipe','pipe'],env:{...process.env,GH_TOKEN:'fixture'}});child.stdout.pipe(process.stdout);child.stderr.resume();child.on('close',code=>{server.close();process.exitCode=code;});});`);
  const gh=new GhClient("fixture",root,Date.now()+10000,process.env,process.execPath,[fixture]);
  const values=await gh.json("ignored",'map({id,tag_name,draft,prerelease,immutable})');
  assert.deepEqual(values,[wire(summary("v1.0.0",1))]);
});

async function preparation(t,overrides={}) {
  const root=await mkdtemp(join(tmpdir(),"release-set-files-"));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const name of ["work","temp","work/docs","work/docs/.well-known"])await mkdir(join(root,name),{recursive:true});
  await writeFile(join(root,"work/docs/index.html"),"documentation");
  await writeFile(join(root,"work/docs/.well-known/info.json"),"{}");
  const raw={schema:2,releases:{"tag-prefix":"v",range:">=1.0.0 <2.0.0","on-empty":"skip"},files:[{from:"installer.sh",to:"install.sh"},{from:"optional",to:"optional",required:false}],aliases:{select:"highest-stable",files:[{from:"install.sh",to:"install.sh"}]},...overrides};
  await writeFile(join(root,"work/policy.json"),JSON.stringify(raw));
  const env={GITHUB_WORKSPACE:join(root,"work"),RUNNER_TEMP:join(root,"temp"),GITHUB_OUTPUT:join(root,"output"),GITHUB_REPOSITORY:"owner/repo",INPUT_CONFIG:"policy.json",INPUT_SITE:"docs"};
  await writeFile(env.GITHUB_OUTPUT,"");
  return {root,env,raw};
}
function provider() {
  const sha=bytes=>"sha256:"+createHash("sha256").update(bytes).digest("hex");
  const releases=[{...summary("v1.0.0",1),commit:"1".repeat(40),assets:[]},
    { ...summary("v1.1.0",2),commit:"2".repeat(40),assets:[{...asset(),id:21,size:2,digest:sha("v1"),bytes:"v1"}]},
    { ...summary("v1.2.0",3),commit:"3".repeat(40),assets:[{...asset(),id:31,size:2,digest:sha("v2"),bytes:"v2"}]}];
  const api={releases,downloads:[],verifyCalls:[],afterDownload:undefined,corrupt:false,noAttestation:false,
    async json(endpoint) {
      if(endpoint==="repos/owner/repo")return {private:false};
      if(endpoint.includes("/releases?"))return releases.map(wire);
      if(endpoint.includes("/releases/tags/"))return wire(releases.find(r=>r.tag===decodeURIComponent(endpoint.split("/tags/")[1])));
      if(endpoint.includes("/git/ref/tags/"))return {object:{type:"commit",sha:releases.find(r=>r.tag===decodeURIComponent(endpoint.split("/tags/")[1])).commit}};
      const m=endpoint.match(/\/releases\/(\d+)\/assets\?/);
      if(m)return structuredClone(releases.find(r=>r.id===Number(m[1])).assets).map(({bytes,...a})=>a);
      throw new Error("Unexpected endpoint "+endpoint);
    },
    async download(endpoint,path) {
      const id=Number(endpoint.split("/").at(-1));
      const a=releases.flatMap(r=>r.assets).find(a=>a.id===id);
      api.downloads.push(id);await writeFile(path,api.corrupt?"bad":a.bytes);api.afterDownload?.(api);
    },
    async verify(tag,path) {api.verifyCalls.push(tag);assert.ok(await readFile(path));if(api.noAttestation)throw new Error("No attestation capability");}
  };
  return api;
}

test("unversioned mixed release-set and aliases produce the same canonical policy, files and digest",async t=>{
  const f=await preparation(t,{schema:undefined,files:["installer.sh",{from:"optional",to:"optional",required:false}],aliases:{select:"highest-stable",files:["installer.sh"]}});
  const shorthand=await distribute(f.env,provider());
  const expected={schema:2,releases:{"tag-prefix":"v",range:">=1.0.0 <2.0.0","on-empty":"skip"},files:[{from:"installer.sh",to:"installer.sh",required:true},{from:"optional",to:"optional",required:false}],aliases:{select:"highest-stable",files:[{from:"installer.sh",to:"installer.sh"}]}};
  await writeFile(join(f.env.GITHUB_WORKSPACE,"policy.json"),JSON.stringify(expected));
  const legacy=await distribute(f.env,provider());
  assert.equal(shorthand.digest,legacy.digest);
  const report=JSON.parse(await readFile(shorthand.report,"utf8"));
  assert.deepEqual(report,JSON.parse(await readFile(legacy.report,"utf8")));
  assert.deepEqual(report.source.policy,{...expected,releases:{"tag-prefix":"v",range:">=1.0.0 <2.0.0","include-prereleases":false,"on-empty":"skip"}});
  assert.deepEqual(await readFile(join(shorthand.path,"installer.sh")),Buffer.from("v2"));
});
test("one preparation merges docs, same-name version bytes and aliases with complete report provenance",async t=>{
  const f=await preparation(t),api=provider();
  const result=await distribute(f.env,api),r=JSON.parse(await readFile(result.report));
  assert.equal(r.schema,2);assert.equal(reportShape(r).length,5);
  for(const [name,bytes] of [["index.html","documentation"],[".well-known/info.json","{}"],["v1.1.0/install.sh","v1"],["v1.2.0/install.sh","v2"],["install.sh","v2"]])assert.equal(await readFile(join(result.path,name),"utf8"),bytes);
  assert.deepEqual(api.downloads,[21,31]);
  assert.deepEqual(r.source.releases.map(r=>[r.tag,r.status]),[["v1.0.0","skipped-empty"],["v1.1.0","selected"],["v1.2.0","selected"]]);
  const alias=r.files.find(f=>f.path==="install.sh");
  assert.deepEqual([alias.releaseId,alias.assetId,alias.aliasOf],[3,31,"v1.2.0/install.sh"]);
  assert.equal(await readFile(join(f.env.GITHUB_WORKSPACE,"docs/index.html"),"utf8"),"documentation");
  assert.ok(!(await readdir(f.env.RUNNER_TEMP)).some(n=>n.startsWith("releaseway-source-")));
  const repeat=await distribute(f.env,api);assert.equal(repeat.digest,result.digest);
});
test("fresh rebuild after a newer release preserves old bytes and advances the root alias",async t=>{
  const f=await preparation(t),api=provider();
  const a=await distribute(f.env,api);
  api.releases.push({...summary("v1.3.0",4),commit:"4".repeat(40),assets:[{...asset(),id:41,bytes:"ok"}]});
  const b=await distribute(f.env,api);
  for(const version of ["v1.1.0","v1.2.0"])assert.deepEqual(await readFile(join(a.path,version,"install.sh")),await readFile(join(b.path,version,"install.sh")));
  assert.equal(await readFile(join(b.path,"install.sh"),"utf8"),"ok");
});
test("destination prefixes versions and alias references without changing source names",async t=>{
  const f=await preparation(t);const result=await distribute({...f.env,INPUT_DESTINATION:"downloads"},provider());
  const r=JSON.parse(await readFile(result.report));
  assert.equal(r.files.find(f=>f.path==="downloads/install.sh").aliasOf,"downloads/v1.2.0/install.sh");
  assert.equal(reportShape(r).length,5);
});
test("partial/empty alias/all-empty and unsafe legacy inputs fail before output",async t=>{
  for(const mutation of [
    api=>{api.releases[1].assets=[{...asset("optional"),bytes:"ok"}];},
    api=>{api.releases[2].assets=[];},
    api=>{for(const r of api.releases)r.assets=[];}
  ]) {
    const f=await preparation(t),api=provider();mutation(api);
    await assert.rejects(distribute(f.env,api));
    assert.equal(await readFile(f.env.GITHUB_OUTPUT,"utf8"),"");assert.deepEqual(await readdir(f.env.RUNNER_TEMP),[]);
    assert.equal(api.downloads.length,0);
  }
  for(const bad of [{INPUT_TAG:"v1.1.0"},{INPUT_ROOT:"."},{INPUT_COMMIT:"a".repeat(40)}]){
    const f=await preparation(t);await assert.rejects(distribute({...f.env,...bad},provider()),/cannot be combined/);
    assert.deepEqual(await readdir(f.env.RUNNER_TEMP),[]);
  }
});
test("global byte budgets include alias copies and the baseline and leave no partial output",async t=>{
  for(const limit of [5,6,20]) {
    const f=await preparation(t),api=provider();
    await assert.rejects(distribute({...f.env,"INPUT_MAX-TOTAL-BYTES":String(limit)},api),/limit|within/);
    assert.deepEqual(await readdir(f.env.RUNNER_TEMP),[]);assert.equal(await readFile(f.env.GITHUB_OUTPUT,"utf8"),"");
    if(limit===5)assert.equal(api.downloads.length,0);
  }
});
test("source mutation including an empty skipped release aborts the entire preparation",async t=>{
  for(const mutate of [
    api=>{api.releases[1].commit="a".repeat(40);},
    api=>{api.releases[1].assets[0].id=23;},
    api=>{api.releases[0].assets=[{...asset(),id:11,bytes:"ok"}];},
    api=>{api.releases[1].prerelease=true;},
    api=>{api.releases.push({...summary("v1.4.0",4),commit:"4".repeat(40),assets:[]});}
  ]) {
    const f=await preparation(t),api=provider();api.afterDownload=api=>{api.afterDownload=undefined;mutate(api);};
    await assert.rejects(distribute(f.env,api),/changed|superseded/);
    assert.deepEqual(await readdir(f.env.RUNNER_TEMP),[]);assert.equal(await readFile(f.env.GITHUB_OUTPUT,"utf8"),"");
  }
});
test("tampered bytes and unavailable attestation never downgrade to an empty skip",async t=>{
  for(const mode of ["corrupt","attested"]){
    const f=await preparation(t),api=provider();api.corrupt=mode==="corrupt";api.noAttestation=true;
    await assert.rejects(distribute({...f.env,INPUT_VERIFICATION:mode==="attested"?"attested":"digest"},api));
    assert.deepEqual(await readdir(f.env.RUNNER_TEMP),[]);assert.equal(await readFile(f.env.GITHUB_OUTPUT,"utf8"),"");
  }
});
test("report2 rejects altered file source, skipped status, alias, policy and missing membership",async t=>{
  const f=await preparation(t),result=await distribute(f.env,provider()),r=JSON.parse(await readFile(result.report));
  for(const mutate of [
    r=>{r.files.find(f=>f.assetId).releaseId=1;},
    r=>{r.files.find(f=>f.aliasOf).aliasOf="v1.1.0/install.sh";},
    r=>{r.source.releases[0].status="selected";},
    r=>{r.source.policy.releases.range="*";},
    r=>{r.files=r.files.filter(f=>f.path!=="v1.1.0/install.sh");r.digest=contentDigest(r.files);}
  ]) {const bad=structuredClone(r);mutate(bad);assert.throws(()=>reportShape(bad));}
});
test("release-set conflicts preserve the input site and replace only selected targets",async t=>{
  const f=await preparation(t);await writeFile(join(f.env.GITHUB_WORKSPACE,"docs/install.sh"),"old");
  await assert.rejects(distribute(f.env,provider()),/conflicts/);
  assert.deepEqual(await readdir(f.env.RUNNER_TEMP),[]);
  const result=await distribute({...f.env,INPUT_CONFLICT:"replace"},provider());
  assert.equal(await readFile(join(result.path,"install.sh"),"utf8"),"v2");
  assert.equal(await readFile(join(f.env.GITHUB_WORKSPACE,"docs/install.sh"),"utf8"),"old");
  assert.equal(await readFile(join(result.path,"index.html"),"utf8"),"documentation");
});
test("present optional assets are inventoried while global deadline failures clean the source",async t=>{
  const f=await preparation(t),api=provider();api.releases[2].assets.push({...asset("optional",32),bytes:"ok"});
  const result=await distribute(f.env,api),r=JSON.parse(await readFile(result.report));
  assert.equal(r.files.find(f=>f.path==="v1.2.0/optional").assetId,32);assert.deepEqual(api.downloads,[21,31,32]);
  const g=await preparation(t);
  await assert.rejects(prepareReleaseSet(options(g.env),g.env,Date.now()-1,parseConfig(g.raw),provider()),/deadline/);
  assert.deepEqual(await readdir(g.env.RUNNER_TEMP),[]);assert.equal(await readFile(g.env.GITHUB_OUTPUT,"utf8"),"");
});
