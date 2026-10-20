import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { GhCliApi } from "../src/github.ts";
import { MAX_NOTES_BYTES } from "../src/text.ts";

const apiModule = new URL("../src/github.ts", import.meta.url).href;
const megabyte = 1024 * 1024;
const endpoint = (name, page = 1) =>
  `repos/owner/${name}/releases?per_page=100&page=${page}`;

// Keep HTTP serving off the main thread: the production adapter blocks with
// spawnSync. Real gh performs the jq projections; no test reimplements them.
async function fixture(t, routes, pullRequest = {}) {
  const located = spawnSync("bash", ["-c", "command -v gh"], { encoding: "utf8" });
  assert.equal(located.status, 0, "GitHub CLI (gh) is required for adapter regression tests");
  const root = await mkdtemp(join(tmpdir(), "releaseway-gh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = new Worker(`
    const {workerData, parentPort} = require("node:worker_threads");
    const {createServer} = require("node:http");
    const requests = [];
    const server = createServer((req, res) => {
      req.resume();
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/_requests") return res.end(JSON.stringify(requests));
      requests.push(req.url.slice(1));
      const route = workerData[req.url.slice(1)];
      if (route === undefined) {
        res.statusCode = 404;
        return res.end(JSON.stringify({message: "Unexpected fixture endpoint"}));
      }
      res.end(JSON.stringify(route));
    });
    server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
  `, { eval: true, workerData: routes });
  t.after(() => worker.terminate());
  const [port] = await once(worker, "message");
  const base = `http://127.0.0.1:${port}`;
  // Only route CLI endpoints to the local fixture. The adapter's real default
  // runner, output limits, JSON parsing and page traversal remain in use.
  await writeFile(join(root, "gh"), `#!${process.execPath}
const {spawnSync} = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "release" && args[1] === "view") {
  process.stdout.write("42\\n");
} else if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(process.env.FIXTURE_PR);
} else {
  const routed = args.map(arg => arg.startsWith("repos/") ? process.env.FIXTURE_BASE + "/" + arg : arg);
  const result = spawnSync(process.env.FIXTURE_GH, routed, {stdio: "inherit"});
  process.exit(result.status ?? 1);
}
`, { mode: 0o755 });

  return {
    run(method, ...args) {
      return spawnSync(process.execPath, ["--input-type=module", "-e", `
        import {GhCliApi} from ${JSON.stringify(apiModule)};
        try {
          const value = await new GhCliApi()[${JSON.stringify(method)}](...${JSON.stringify(args)});
          process.stdout.write(JSON.stringify(value));
        } catch (error) {
          process.stderr.write(error.message);
          process.exitCode = 1;
        }
      `], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * megabyte,
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH}`,
          GH_TOKEN: "local-fixture-only",
          GH_HOST: "github.com",
          GH_DEBUG: "",
          GH_PROMPT_DISABLED: "1",
          FIXTURE_BASE: base,
          FIXTURE_GH: located.stdout.trim(),
          FIXTURE_PR: JSON.stringify(pullRequest),
        },
      });
    },
    async requests() {
      return (await fetch(`${base}/_requests`)).json();
    },
  };
}

function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function release(index) {
  return {
    tag_name: `component/v1.0.${index}`,
    draft: index % 4 === 0,
    prerelease: index % 3 === 0,
    body: "release notes".repeat(9000),
    assets: [{ name: "app", uploader: { login: "builder" } }],
  };
}

test("release discovery projects large pages without losing draft/prerelease entries or later pages", async t => {
  const releases = Array.from({ length: 101 }, (_, i) => release(i));
  assert.ok(Buffer.byteLength(JSON.stringify(releases.slice(0, 100))) > 8 * megabyte);
  const api = await fixture(t, {
    [endpoint("many")]: releases.slice(0, 100),
    [endpoint("many", 2)]: releases.slice(100),
  });
  assert.deepEqual(success(api.run("publishedReleases", "owner/many")),
    releases.map(r => ({ tag: r.tag_name, draft: r.draft, prerelease: r.prerelease })));
  assert.deepEqual(await api.requests(), [endpoint("many"), endpoint("many", 2)]);
});

test("release discovery handles exactly 100 entries and an empty first page", async t => {
  const releases = Array.from({ length: 100 }, (_, i) => ({
    tag_name: `v1.0.${i}`, draft: false, prerelease: false,
  }));
  const api = await fixture(t, {
    [endpoint("exact")]: releases,
    [endpoint("exact", 2)]: [],
    [endpoint("empty")]: [],
  });
  assert.equal(success(api.run("publishedReleases", "owner/exact")).length, 100);
  assert.deepEqual(success(api.run("publishedReleases", "owner/empty")), []);
  assert.deepEqual(await api.requests(), [endpoint("exact"), endpoint("exact", 2), endpoint("empty")]);
});

test("release projections preserve malformed-response rejection", async t => {
  const api = await fixture(t, {
    [endpoint("object")]: { releases: [] },
    [endpoint("item")]: [null],
    [endpoint("missing")]: [{ tag_name: "v1.0.0", draft: false }],
    [endpoint("type")]: [{ tag_name: "v1.0.0", draft: "false", prerelease: false }],
    "repos/owner/example/releases/42": [],
  });
  for (const [repository, message] of [
    ["object", /page must be an array/],
    ["item", /item must be an object/],
    ["missing", /missing required fields/],
    ["type", /missing required fields/],
  ]) {
    const result = api.run("publishedReleases", `owner/${repository}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
  for (const [method, arg] of [["releaseByTag", "v1.0.0"], ["releaseBody", 42]]) {
    const result = api.run(method, "owner/example", arg);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release response must be an object/);
  }
});

test("release pagination fails at its existing bound instead of returning incomplete evidence", async () => {
  let calls = 0;
  const api = new GhCliApi(() => {
    calls += 1;
    return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
      tag_name: `v1.${calls}.${i}`, draft: false, prerelease: false,
    })));
  });
  await assert.rejects(() => api.publishedReleases("owner/example"), /bounded pagination limit of 20 pages/);
  assert.equal(calls, 20);
});

test("PR association projects large pages and still deduplicates and reads landing metadata", async t => {
  const path = page => `repos/owner/example/commits/${"a".repeat(40)}/pulls?per_page=100&page=${page}`;
  const pullRequest = {
    number: 7, title: "feat: shipped", body: "PR body\n", mergedAt: "2026-10-01T00:00:00Z",
    mergeCommit: { oid: "b".repeat(40) }, author: { login: "alice", isBot: false }, labels: [],
  };
  const api = await fixture(t, {
    [path(1)]: Array.from({ length: 100 }, () => ({ number: 7, body: "x".repeat(100000) })),
    [path(2)]: [{ number: 7, body: "duplicate" }],
  }, pullRequest);
  const result = success(api.run("associatedPullRequests", "owner/example", "a".repeat(40)));
  assert.deepEqual(result, [{
    number: 7, title: "feat: shipped", body: "PR body\n", mergedAt: "2026-10-01T00:00:00Z",
    mergeCommitSha: "b".repeat(40), userLogin: "alice", userType: "User", labels: [],
    baseRepository: "owner/example",
  }]);
  assert.deepEqual(await api.requests(), [path(1), path(2)]);
});

test("snapshots, body verification and native notes preserve a full-size escaped UTF-8 body", async t => {
  const prefix = "한글 🦊\n";
  const escaped = '"\\\t\r\n'.repeat(Math.floor((MAX_NOTES_BYTES - Buffer.byteLength(prefix) - 2) / 5));
  const body = prefix + escaped + " ".repeat(MAX_NOTES_BYTES - Buffer.byteLength(prefix + escaped) - 2) + "\r\n";
  assert.equal(Buffer.byteLength(body), MAX_NOTES_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ body })) > megabyte);
  const api = await fixture(t, {
    "repos/owner/example/releases/42": {
      id: 42, tag_name: "v1.0.0", name: "Title", body, draft: false, prerelease: true,
      immutable: true, html_url: "https://example.invalid/releases/42",
      assets: [{ name: "app", metadata: "x".repeat(9 * megabyte) }],
    },
    "repos/owner/example/releases/generate-notes": { body, name: "Native title" },
  });
  assert.deepEqual(success(api.run("releaseByTag", "owner/example", "v1.0.0")), {
    id: 42, tag: "v1.0.0", name: "Title", body, draft: false, prerelease: true,
    immutable: true, url: "https://example.invalid/releases/42",
  });
  assert.equal(success(api.run("releaseBody", "owner/example", 42)), body);
  assert.deepEqual(success(api.run("generateReleaseNotes", {
    repository: "owner/example", tag: "v1.0.0", targetSha: "a".repeat(40),
  })), { body, name: "Native title" });
});

test("body projection preserves missing, empty and non-final-newline bodies", async t => {
  const bodies = [undefined, null, "", '한글 "quote"\\path\r\ntrailing spaces  '];
  const api = await fixture(t, Object.fromEntries(bodies.map((body, id) => [
    `repos/owner/example/releases/${id + 1}`, { body, assets: [{ name: "ignored" }] },
  ])));
  for (const [id, body] of bodies.entries()) {
    assert.equal(success(api.run("releaseBody", "owner/example", id + 1)), body ?? "");
  }
});

test("projected output remains bounded and reports a useful limit error", async t => {
  const api = await fixture(t, {
    [endpoint("oversized")]: [{ tag_name: "x".repeat(9 * megabyte), draft: false, prerelease: false }],
  });
  const result = api.run("publishedReleases", "owner/oversized");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub CLI output exceeded maximum size 8388608 bytes/);
});

test("CLI failures remain failures instead of becoming empty release history", async t => {
  const api = await fixture(t, {});
  const result = api.run("publishedReleases", "owner/missing");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gh api failed:.*404/);
});
