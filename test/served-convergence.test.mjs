import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyServed } from "../src/distribution/verify-served.ts";
const file=(path,bytes)=>({path,size:Buffer.byteLength(bytes),sha256:createHash("sha256").update(bytes).digest("hex"),origin:"selected"});
test("larger, shorter and same-size stale responses converge without accepting wrong bytes",async()=>{
  for(const stale of ["long previous file","o","no"]){
    let calls=0;
    await verifyServed("https://example.test/base/",[file("x","ok")],async()=>new Response(++calls===1?stale:"ok"),Date.now()+1800);
    assert.equal(calls,2);
  }
});
test("oversized streams stop reading and empty files remain strict",async()=>{
  let cancelled=0,calls=0;
  await assert.rejects(verifyServed("https://example.test/",[file("x","")],async()=>{calls++;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("oversize"));},cancel(){cancelled++;}}));},Date.now()+30),/deadline/);
  assert(calls>=1);assert.equal(cancelled,calls);
  await verifyServed("https://example.test/",[file("x","")],async()=>new Response(null));
});
test("fatal redirect policy aborts another worker's stalled stream",async()=>{
  let cancelled=false;
  await assert.rejects(verifyServed("https://example.test/base/",[file("a","ok"),file("b","ok")],async url=>String(url).endsWith("/a")?new Response(null,{status:302,headers:{location:"https://other.test/x"}}):new Response(new ReadableStream({cancel(){cancelled=true;}})),Date.now()+2000),/Redirect/);
  assert(cancelled);
});
