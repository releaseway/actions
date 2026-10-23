import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, readConfig } from "../src/distribution/config.ts";
import { githubErrorCommand } from "../src/errors.ts";

async function reader(t) {
  const root=await mkdtemp(join(tmpdir(),"distribution-errors-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return async text=>{await writeFile(join(root,"policy.yml"),text);return readConfig(root,"policy.yml");};
}

test("unknown keys identify each object, exact key and original YAML location",async t=>{
  const read=await reader(t);
  const examples=[
    ['files: [a]\nextra: private-value\n',2,1,'extra'],
    ['releases:\n  tags: [v1]\n  typo: private-value\nfiles: [a]\n',3,3,'releases.typo'],
    ['files:\n  - a\n  - from: b\n    to: b\n  - from: c\n    to: c\n    requried: private-value\n',7,5,'files[2].requried'],
    ['releases: {tags: [v1]}\nfiles: [a]\naliases:\n  tag: v1\n  files: [a]\n  typo: private-value\n',6,3,'aliases.typo'],
    ['releases: {tags: [v1]}\nfiles: [a, b]\naliases:\n  tag: v1\n  files:\n    - a\n    - from: b\n      to: b\n      typo: private-value\n',9,7,'aliases.files[1].typo'],
  ];
  for(const [source,line,column,path] of examples) await assert.rejects(read(source),error=>{
    assert.ok(error.message.startsWith(`"policy.yml":${line}:${column}: Unknown key`),error.message);
    assert.ok(error.message.includes(`at ${path}`),error.message);
    assert.match(error.message,/Allowed keys:/);assert.ok(!error.message.includes('private-value'));
    return true;
  });
});

test("JSON, CRLF, Unicode and quoted keys retain positions and unambiguous paths",async t=>{
  const read=await reader(t);
  await assert.rejects(read('{"files":["한글"],"bad.key":0}'),error=>{
    assert.ok(error.message.startsWith('"policy.yml":1:17:'),error.message);
    assert.ok(error.message.includes('at ["bad.key"]'));return true;
  });
  await assert.rejects(read('# comment\r\nfiles: [한글]\r\n"bad[key]": 0\r\n'),error=>{
    assert.ok(error.message.startsWith('"policy.yml":3:1:'),error.message);
    assert.ok(error.message.includes('at ["bad[key]"]'));return true;
  });
});

test("missing fields use parent location and shorthand path failures use scalar location",async t=>{
  const read=await reader(t);
  await assert.rejects(read('files:\n  - from: a\n'),/"policy.yml":2:5: to must be a string at files\[0\]\.to/);
  await assert.rejects(read('files:\n  - a\n  - ../bad\n'),/"policy.yml":3:5: .* at files\[1\]/);
  await assert.rejects(read('files:\n  - a\n  - from: b\n    to: A\n'),/"policy.yml":3:5: Duplicate public target; conflicts with files\[0\] at files\[1\]/);
  await assert.rejects(read('files: [a, a/b]\n'),/File and directory target conflict with files\[0\] at files\[1\]/);
});

test("direct parser preserves logical paths without inventing source coordinates",()=>{
  assert.throws(()=>parseConfig({files:[{from:'a',to:'a',typo:true}]}),/Unknown key "typo".*at files\[0\]\.typo/);
  assert.throws(()=>parseConfig({releases:null,files:['a']}),/Expected .* at releases/);
  assert.throws(()=>parseConfig({schema:1,releases:{tags:['v1']},files:['a']}),/Unknown key "releases"/);
  assert.throws(()=>parseConfig({releases:{tags:['v1']},files:['a'],aliases:{tag:'v1',select:'highest-stable',files:['a']}}),/exactly one.*at aliases/);
});

test("strict syntax errors keep positions while anchors, merge and non-string keys fail closed",async t=>{
  const read=await reader(t);
  await assert.rejects(read('files: [a]\nfiles: [b]\n'),/"policy.yml":2:1: Invalid strict .*DUPLICATE_KEY/);
  for(const source of ['files: &f [a]\n','files: *missing\n','files: [a]\n<<: {}\n','files: [a]\n123: x\n','? [files]\n: [a]\n']) {
    await assert.rejects(read(source),/"policy.yml":\d+:\d+: Invalid strict YAML\/JSON/);
  }
  await assert.rejects(read('files: [a'),/Invalid strict YAML\/JSON/);
  await assert.rejects(read('files: '+ '['.repeat(20)+'a'+']'.repeat(20)),/deep nesting/);
  await assert.rejects(read('#'+'a'.repeat(256*1024)),/Config exceeds 256 KiB/);
});

test("untrusted keys stay bounded, escaped and never become workflow commands",async t=>{
  const read=await reader(t);
  await assert.rejects(read(JSON.stringify({files:['a'],['bad\n::warning::%']: 'private-value'})),error=>{
    assert.ok(!error.message.includes('\n'));assert.ok(!error.message.includes('private-value'));
    assert.ok(error.message.includes('bad\\n::warning::%'));
    const output=githubErrorCommand(error);assert.ok(output.includes('%25'));assert.equal(output.split('\n').length,1);return true;
  });
  assert.throws(()=>parseConfig({files:['a'],['x'.repeat(10000)]:true}),error=>error.message.length<2000);
});
