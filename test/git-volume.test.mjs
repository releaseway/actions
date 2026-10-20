import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectCommitEvidence, GitRepository } from "../src/git.ts";
import { resolveRange } from "../src/range.ts";

async function history(count, merges, fn) {
  const root=await mkdtemp(join(tmpdir(),"git-volume-"));
  const git=(args,options={})=>{const r=spawnSync("git",["-c","tag.gpgsign=false","-C",root,...args],{encoding:"utf8",timeout:30000,...options});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  try {
    git(["init","-b","main"]);
    let stream="";
    for(let i=1;i<=count;i++)stream+=`commit refs/heads/main\nmark :${i}\ncommitter Fixture <fixture@example.invalid> ${1000000000+i} +0000\ndata 8\nfix: x\n\n${i>1?`from :${i-1}\n`:""}${merges&&i>2?"merge :1\n":""}\n`;
    git(["fast-import","--quiet"],{input:stream});
    await fn(new GitRepository(root),git);
  } finally { await rm(root,{recursive:true,force:true}); }
}
test("automatic range finds a one-commit release in a 30000-commit repository",async()=>{
  await history(30000,false,async(repository,git)=>{
    git(["tag","v1.0.0","HEAD~1"]);git(["tag","v1.0.1"]);
    const range=resolveRange({repository,targetTag:"v1.0.1",targetSha:git(["rev-parse","HEAD"]),releases:[{tag:"v1.0.0",prerelease:false}]});
    assert.equal(range.baseTag,"v1.0.0");
    assert.equal(collectCommitEvidence(repository,range.targetSha,range.baseSha).length,1);
    assert.throws(()=>collectCommitEvidence(repository,range.targetSha,null),/maximum commit count/);
    // Exercise cursor continuation beyond the first bounded page.
    let visited=0;for(const sha of repository.firstParentChain(range.targetSha)){assert.match(sha,/^[a-f0-9]{40}$/);visited++;}
    assert.equal(visited,30000);
  });
});
test("9000 merge commits fit the release limit and retain parents and deterministic order",async()=>{
  await history(9000,true,async(repository,git)=>{
    const head=git(["rev-parse","HEAD"]),base=git(["rev-list","--max-parents=0",head]);
    for(const from of [null,base]){
      const evidence=collectCommitEvidence(repository,head,from);
      assert.equal(evidence.length,from?8999:9000);assert.equal(evidence.at(-1).sha,head);
      assert.equal(evidence.at(-1).parents.length,2);assert.match(evidence.at(-1).message,/fix: x/);
      assert.equal(evidence.at(-1).authorName,"Fixture");
      const positions=new Map(evidence.map((c,i)=>[c.sha,i]));
      for(const c of evidence)for(const parent of c.parents)if(positions.has(parent))assert(positions.get(parent)<positions.get(c.sha));
    }
  });
});
