import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { parseConfig } from "../src/distribution/config.ts";
import { reportShape } from "../src/distribution/report.ts";
import { policyDigest } from "../src/distribution/release-set.ts";

// Conditional requirements reuse property declarations from the outer schema.
const ajv=new Ajv2020({strict:true,strictRequired:false,allErrors:true});
ajv.addSchema(JSON.parse(await readFile(new URL("../distribute/config.schema.json",import.meta.url))),"config.schema.json");
ajv.addSchema(JSON.parse(await readFile(new URL("../distribute/report.schema.json",import.meta.url))),"report.schema.json");
const validateConfig=ajv.getSchema("config.schema.json"),validateReport=ajv.getSchema("report.schema.json");
const policy={schema:2,releases:{tags:["v1"],"on-empty":"error"},files:[{from:"a",to:"a",required:true}]};
test("published config schema and parser agree on independent structural examples",()=>{
  for(const example of [{schema:1,files:[{from:"dist/a",to:"a"}]},policy,
    {files:["a",{from:"dist/b",to:"b"}]}, {schema:1,files:["a"]},
    {releases:{tags:["v1"]},files:["a"],aliases:{tag:"v1",files:["a"]}},
    {schema:2,releases:{tags:["v1"]},files:["a",{from:"b",to:"c",required:false}]},
    {schema:2,releases:{"tag-prefix":"v",range:"*"},files:[{from:"a",to:"a"},{from:"b",to:"b",required:false}],aliases:{select:"highest-stable",files:[{from:"a",to:"a"}]}}]) {
    assert.equal(validateConfig(example),true,JSON.stringify(validateConfig.errors));assert.doesNotThrow(()=>parseConfig(example));
  }
  for(const mutate of [x=>{x.schema=3;},x=>{x.unknown=true;},x=>{x.releases.tags=[];},x=>{x.releases.range="*";},x=>{x.releases["on-empty"]=null;},x=>{x.files[0].required=null;},x=>{x.files[0].required=false;}]) {
    const value=structuredClone(policy);mutate(value);
    assert.equal(validateConfig(value),false,JSON.stringify(value));assert.throws(()=>parseConfig(value));
  }
  for(const value of [
    {files:[]},{files:[""]},{files:[null]},{files:[123]},{files:[true]},{files:[["a"]]},
    {files:[{from:"a"}]},{files:[{to:"a"}]},{files:[{from:"a",to:"a",required:true}]},
    {schema:1,releases:{tags:["v1"]},files:["a"]}, {schema:2,files:["a"]},
    {schema:null,files:["a"]},{schema:"2",files:["a"]},{schema:true,files:["a"]},
    {releases:null,files:["a"]},{releases:{},files:["a"]},
    {aliases:{tag:"v1",files:["a"]},files:["a"]},
    {releases:{tags:["v1"]},files:[{from:"a",to:"a",required:false}]},
    {releases:{tags:["v1"]},files:["a"],aliases:{tag:"v1",files:[]}},
  ]) {
    assert.equal(validateConfig(value),false,JSON.stringify(value));assert.throws(()=>parseConfig(value));
  }
});
test("shorthand preserves mode, literal paths, aliases and canonical policy identity",()=>{
  assert.deepEqual(parseConfig({files:["dist/install.sh"]}),{schema:1,files:[{from:"dist/install.sh",to:"dist/install.sh"}]});
  const explicit={...policy,aliases:{tag:"v1",files:[{from:"a",to:"a"}]}};
  const shorthand={releases:{tags:["v1"]},files:["a"],aliases:{tag:"v1",files:["a"]}};
  assert.deepEqual(parseConfig(shorthand),parseConfig(explicit));
  assert.equal(policyDigest(parseConfig(shorthand)),policyDigest(parseConfig(explicit)));
  for(const files of [["a",{from:"b",to:"A"}],["a","a/b"],["é","e\u0301"],["../a"],["./a"],["a//b"],["a\\b"],["CON"],["*.sh"]])assert.throws(()=>parseConfig({files}));
  assert.throws(()=>parseConfig({releases:{tags:["v1"]},files:["dist/a"]}));
  assert.throws(()=>parseConfig({...shorthand,aliases:{tag:"v1",files:["missing"]}}));
  assert.deepEqual(parseConfig({files:["a",{from:"a",to:"b"}]}).files,[{from:"a",to:"a"},{from:"a",to:"b"}]);
  const many=Array.from({length:10000},(_,i)=>`file-${i}`);
  assert.equal(parseConfig({files:many}).files.length,10000);
  assert.throws(()=>parseConfig({files:[...many,"extra"]}));
});
test("published report schema and runtime agree on structural identity examples",()=>{
  const sha=value=>createHash("sha256").update(value).digest("hex");
  const hash=sha("ok");
  const value={schema:2,base:false,baseline:null,source:{kind:"github-release-set",repository:"owner/repo",verification:"digest",policy,
    policyDigest:"sha256:"+sha(JSON.stringify(policy)),destination:"",aliasTag:null,
    releases:[{releaseId:1,tag:"v1",commit:"a".repeat(40),prerelease:false,immutable:true,status:"selected",assets:[{id:2,name:"a",size:2,digest:"sha256:"+hash,state:"uploaded"}]}]},
    files:[{path:"v1/a",size:2,sha256:hash,origin:"selected",from:"a",releaseId:1,assetId:2}],digest:"sha256:"+sha(JSON.stringify([["v1/a",2,hash]]))};
  assert.equal(validateReport(value),true,JSON.stringify(validateReport.errors));assert.doesNotThrow(()=>reportShape(value));
  const defaults=structuredClone(value);
  delete defaults.source.policy.releases["on-empty"];delete defaults.source.policy.files[0].required;
  assert.equal(validateReport(defaults),true,JSON.stringify(validateReport.errors));assert.doesNotThrow(()=>reportShape(defaults));
  for(const mutate of [x=>{delete x.source.policy.schema;},x=>{x.source.policy.files=["a"];},
    x=>{x.source.policy.aliases={tag:"v1",files:["a"]};}]) {
    const bad=structuredClone(value);mutate(bad);
    assert.equal(validateReport(bad),false);assert.throws(()=>reportShape(bad));
  }
  for(const mutate of [x=>{delete x.baseline;},x=>{x.source.releases[0].commit="bad";},x=>{x.source.releases[0].assets[0].state="new";},x=>{x.files[0].sha256="bad";},x=>{x.files[0].assetId=true;},x=>{x.source.kind="local";}]) {
    const bad=structuredClone(value);mutate(bad);
    assert.equal(validateReport(bad),false,JSON.stringify(bad));assert.throws(()=>reportShape(bad));
  }
});
