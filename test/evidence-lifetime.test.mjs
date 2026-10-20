import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvidenceRepository, GitRepository } from "../src/git.ts";
import { prepareNotes } from "../src/prepare.ts";
import { resolveActionInputs } from "../src/contract.ts";

function git(path, ...args) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-C", path, ...args], { encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
async function fixture() {
  // Git matches includeIf.gitdir against the physical path (/private/var on macOS).
  const root = await realpath(await mkdtemp(join(tmpdir(), "evidence-lifetime-")));
  git(root, "init"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "x"), "x"); git(root, "add", "."); git(root, "commit", "-m", "fix: fixture"); git(root, "tag", "v1.0.0");
  return { root, sha: git(root, "rev-parse", "HEAD") };
}
const evidenceDirs = async (root) => (await readdir(root)).filter(n => n.startsWith("releaseway-notes-git-"));

test("conditional checkout credentials reach authenticated HTTP fetch without persistence", async () => {
  const { root, sha } = await fixture();
  // Separate process: the product intentionally runs Git synchronously.
  const server = spawn(process.execPath, ["-e", `
    const http=require('http'),fs=require('fs'),path=require('path');
    http.createServer((q,r)=>{
      if(q.headers.authorization!=='Basic fixture-token'){r.writeHead(401,{'WWW-Authenticate':'Basic realm="fixture"'});r.end();return;}
      fs.readFile(path.join(process.argv[1],new URL(q.url,'http://x').pathname),(e,b)=>{r.writeHead(e?404:200);r.end(e?'missing':b);});
    }).listen(0,'127.0.0.1',function(){console.log(this.address().port)});
  `, join(root, ".git")], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    git(root, "update-server-info");
    const [chunk] = await once(server.stdout, "data");
    const url = `http://127.0.0.1:${String(chunk).trim()}`;
    git(root, "remote", "add", "origin", url);
    const credentials = join(root, "credentials");
    await writeFile(credentials, `[http "${url}/"]\nextraheader = Authorization: Basic fixture-token\n`);
    git(root, "config", `includeIf.gitdir:${root}/.git.path`, credentials);
    git(root, "config", `includeIf.gitdir:/not-this-checkout/.path`, "/missing-credentials");
    const before = await readFile(join(root, ".git/config"), "utf8");
    const repository = new GitRepository(root);
    assert.equal(repository.localHttpAuthConfig().length, 1);
    const evidence = await createEvidenceRepository({ workspace: root, tempRoot: root, targetTag: "v1.0.0", expectedTargetSha: sha });
    assert.equal(evidence.targetSha, sha);
    assert.doesNotMatch(await readFile(join(evidence.path, "config"), "utf8"), /fixture-token|extraheader/);
    assert.equal(await readFile(join(root, ".git/config"), "utf8"), before);
    await rm(evidence.path, { recursive: true });
  } finally { server.kill(); await once(server, "exit"); await rm(root, { recursive: true, force: true }); }
});

test("evidence creation failures and notes consumers release only their temporary repositories", async () => {
  const { root, sha } = await fixture();
  try {
    git(root, "remote", "add", "origin", root);
    await assert.rejects(createEvidenceRepository({ workspace: root, tempRoot: root, targetTag: "missing", expectedTargetSha: sha }), /tag is missing/);
    assert.deepEqual(await evidenceDirs(root), []);
    await assert.rejects(createEvidenceRepository({ workspace: root, tempRoot: root, targetTag: "v1.0.0", expectedTargetSha: "a".repeat(40) }), /does not match/);
    assert.deepEqual(await evidenceDirs(root), []);
    const options = { workspace: root, runnerTemp: root, tag: "v1.0.0", commit: sha, repository: "releaseway/example", inputs: resolveActionInputs({}) };
    await assert.rejects(prepareNotes({ ...options, api: { publishedReleases: async () => { throw new Error("provider unavailable"); } } }), /provider unavailable/);
    assert.deepEqual(await evidenceDirs(root), []);
    const notes = await prepareNotes({ ...options, api: { publishedReleases: async () => [] } });
    assert.match(await readFile(notes.notesPath, "utf8"), /fixture/);
    assert.deepEqual(await evidenceDirs(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
