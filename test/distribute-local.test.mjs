import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, link, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { distribute } from "../src/distribution/action.ts";
import { publicPath, assertTargets, commonRoot } from "../src/distribution/paths.ts";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "distribute-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, "work"), temp = join(dir, "temp"), output = join(dir, "output");
  await mkdir(workspace); await mkdir(temp); await writeFile(output, "");
  return { workspace, temp, output, env: { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp, GITHUB_OUTPUT: output } };
}
async function put(root, path, bytes) { const target = join(root, path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, bytes); return target; }
async function report(result) { return JSON.parse(await readFile(result.report, "utf8")); }

test("files alone copies opaque bytes, preserves POSIX execute bits and reports deterministic identity", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 35, 33, 13, 10, 0, 255]);
  const original = await put(f.workspace, "dist/install.sh", bytes); await chmod(original, 0o755);
  await put(f.workspace, "dist/install.ps1", "Write-Output 'hi'\r\n");
  const run = () => distribute({ ...f.env, INPUT_FILES: "dist/install.sh\ndist/install.ps1" });
  const a = await run(), b = await run();
  assert.equal(a.digest, b.digest); assert.notEqual(a.path, b.path);
  assert.deepEqual(await readFile(join(a.path, "install.sh")), bytes);
  assert.deepEqual(await readFile(original), bytes);
  if (process.platform !== "win32") assert.equal((await stat(join(a.path, "install.sh"))).mode & 0o777, 0o755);
  const r = await report(a);
  assert.equal(r.source.kind, "local"); assert.equal(r.files.length, 2);
  const canonical = r.files.map(x => [x.path, x.size, x.sha256]);
  assert.equal(a.digest, "sha256:" + createHash("sha256").update(JSON.stringify(canonical)).digest("hex"));
  assert.ok(!(await readFile(a.report, "utf8")).includes(f.workspace));
});

test("glob root is stable as matches change; exact directory drops its root and root override retains it", async t => {
  const f = await fixture(t); await put(f.workspace, "dist/a.sh", "a");
  const a = await distribute({ ...f.env, INPUT_FILES: "dist/*.sh" });
  await put(f.workspace, "dist/b.sh", "b");
  const b = await distribute({ ...f.env, INPUT_FILES: "dist/*.sh" });
  assert.deepEqual((await report(a)).files.map(x => x.path), ["a.sh"]);
  assert.deepEqual((await report(b)).files.map(x => x.path), ["a.sh", "b.sh"]);
  const c = await distribute({ ...f.env, INPUT_FILES: "dist" });
  assert.deepEqual((await report(c)).files.map(x => x.path), ["a.sh", "b.sh"]);
  const d = await distribute({ ...f.env, INPUT_ROOT: ".", INPUT_FILES: "dist/*.sh" });
  assert.deepEqual((await report(d)).files.map(x => x.path), ["dist/a.sh", "dist/b.sh"]);
});

test("common ancestors preserve distinct subdirectories and duplicate selections collapse", async t => {
  const f = await fixture(t); await put(f.workspace, "dist/a/install.sh", "a"); await put(f.workspace, "dist/b/install.sh", "b");
  const a = await distribute({ ...f.env, INPUT_FILES: "dist/a/install.sh\ndist/b/install.sh\ndist/a/install.sh" });
  assert.deepEqual((await report(a)).files.map(x => x.path), ["a/install.sh", "b/install.sh"]);
  assert.equal(commonRoot(["dist/deep", "dist", "dist/other"]), "dist");
});

test("dotfiles are selected explicitly, not by directory or broad globs", async t => {
  const f = await fixture(t); await put(f.workspace, "dist/a.sh", "a"); await put(f.workspace, "dist/.env", "hidden"); await put(f.workspace, "dist/.well-known/info.json", "{}");
  const a = await distribute({ ...f.env, INPUT_FILES: "dist/**" });
  assert.deepEqual((await report(a)).files.map(x => x.path), ["a.sh"]);
  const b = await distribute({ ...f.env, INPUT_FILES: "dist/.well-known/**" });
  assert.deepEqual((await report(b)).files.map(x => x.path), ["info.json"]);
});

test("zero matches, empty directories, unsupported glob and capacity failures expose no outputs", async t => {
  const f = await fixture(t); await put(f.workspace, "dist/a.sh", "too big"); await mkdir(join(f.workspace, "empty"));
  for (const extra of [{INPUT_FILES:"missing/*"}, {INPUT_FILES:"empty"}, {INPUT_FILES:"dist/{a,b}"}, {INPUT_FILES:"dist/a.sh", "INPUT_MAX-FILE-BYTES":"1"}, {INPUT_FILES:"dist/a.sh", "INPUT_MAX-TOTAL-BYTES":"1"}]) {
    await assert.rejects(distribute({ ...f.env, ...extra }));
    assert.equal(await readFile(f.output, "utf8"), "");
    assert.deepEqual(await readdir(f.temp), []);
  }
  assert.equal(await readFile(join(f.workspace, "dist/a.sh"), "utf8"), "too big");
});

test("symlinks fail; hardlink input is copied independently", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t); const a = await put(f.workspace, "dist/a.sh", "a");
  await symlink(a, join(f.workspace, "dist/link.sh"));
  await assert.rejects(distribute({...f.env, INPUT_FILES:"dist/*"}), /links/);
  await rm(join(f.workspace,"dist/link.sh"));
  await link(a, join(f.workspace,"dist/hard.sh"));
  const r = await distribute({...f.env, INPUT_FILES:"dist/hard.sh"});
  await writeFile(a,"changed"); assert.equal(await readFile(join(r.path,"hard.sh"),"utf8"),"a");
});

test("portable path keys reject case, normalized Unicode, reserved paths and ancestors", () => {
  for (const s of ["../a", "a//b", "CON.txt", "a/aux", "COM¹.txt", "com²", "COM³.log", "LPT¹", "lpt².txt", "LPT³", "CONIN$", "conout$.txt", "a\\b", "a:stream", "a/.git/config", "a/../b", "/tmp/x", "a."]) assert.throws(() => publicPath(s));
  for (const paths of [["A.sh", "a.sh"], ["é.json", "e\u0301.json"], ["a", "a/b"]]) assert.throws(() => assertTargets(paths));
  assert.equal(publicPath("한국어/hello #%.sh"), "한국어/hello #%.sh");
});

test("built Action runs without gh, npm, or a generator on PATH", async t => {
  const f = await fixture(t); await put(f.workspace, "dist/run.sh", "echo hi\n");
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/distribute.cjs", import.meta.url))], {env:{...f.env,INPUT_FILES:"dist/run.sh",PATH:""},encoding:"utf8"});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(await readFile(f.output,"utf8"), /^path=.+\nreport=.+\ndigest=sha256:[a-f0-9]{64}\n$/);
});


test("explicit .git source is rejected even if its public basename would be safe", async t => {
  const f = await fixture(t); await put(f.workspace,".git/config","private");
  await assert.rejects(distribute({...f.env,INPUT_FILES:".git/config"}));
  assert.equal(await readFile(f.output,"utf8"),"");
});
