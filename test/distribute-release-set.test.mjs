import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseConfig, readConfig } from "../src/distribution/config.ts";
import { releaseInventory, selectReleases, discoverReleaseSet, selectAssets } from "../src/distribution/release-set.ts";
import { GhClient } from "../src/distribution/gh.ts";

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
