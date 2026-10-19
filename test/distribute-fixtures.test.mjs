import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey,verify } from "node:crypto";
import test from "node:test";
import { distribute } from "../src/distribution/action.ts";
import { buildFixture } from "./distribution-fixtures/build.mjs";
test("authored and generated scripts, two apps, opaque resources and signed JSON share the files-only contract",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"generic-fixtures-"));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,"temp"));
 const workspace=join(dir,"work");await mkdir(workspace);await buildFixture(join(workspace,"payload"));
 const r=await distribute({GITHUB_WORKSPACE:workspace,RUNNER_TEMP:join(dir,"temp"),INPUT_FILES:"payload"});
 const report=JSON.parse(await readFile(r.report,"utf8"));assert.equal(report.files.length,9);
 for(const f of report.files)assert.deepEqual(await readFile(join(r.path,f.path)),await readFile(join(workspace,"payload",f.path)));
 assert.deepEqual(report.files.map(f=>f.path),["apps/a/run.mjs","apps/b/run.mjs","authored/bootstrap.sh","authored/diagnose.ps1","generated/bootstrap.mjs","resources/payload.bin","updates/latest.json","updates/latest.json.sig","updates/public.pem"]);
 const key=createPublicKey(await readFile(join(r.path,"updates/public.pem")));
 assert.ok(verify(null,await readFile(join(r.path,"updates/latest.json")),key,await readFile(join(r.path,"updates/latest.json.sig"))));
});
