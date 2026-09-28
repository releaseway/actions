import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  requireNode24,
  runAction,
} from "../src/action.ts";

class FakeApi {
  constructor(release = null) {
    this.release = release;
  }

  async releaseByTag() {
    return this.release;
  }

  async publishedReleases() {
    return [];
  }

  async associatedPullRequests() {
    return [];
  }

  async generateReleaseNotes() {
    return { name: "", body: "" };
  }

  async releaseBody() {
    return this.release?.body ?? "";
  }
}

function baseEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "releaseway/example",
    GITHUB_OUTPUT: "/github/output",
    GITHUB_WORKSPACE: "/workspace",
    RUNNER_TEMP: "/tmp",
    INPUT_TAG: "v1.0.0",
    INPUT_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    INPUT_NOTES: "none",
    INPUT_NOTES_EXISTING: "auto",
    INPUT_NOTES_PREVIEW: "false",
    ...overrides,
  };
}

test("action metadata keeps composite token injection and exposes new notes contract", async () => {
  const metadata = await readFile(resolve("action.yml"), "utf8");

  assert.match(metadata, /using:\s*composite/);
  assert.match(
    metadata,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
  );
  assert.match(metadata, /node-version:\s*"24"/);
  assert.match(metadata, /node "\$GITHUB_ACTION_PATH\/dist\/main\.cjs"/);
  assert.match(
    metadata,
    /GH_TOKEN:\s*\$\{\{ inputs\.token != '' && inputs\.token \|\| github\.token \}\}/,
  );
  for (const input of [
    "notes",
    "notes-config",
    "notes-file",
    "notes-existing",
    "notes-preview",
  ]) {
    assert.match(metadata, new RegExp(`^  ${input}:`, "m"));
  }
  assert.doesNotMatch(metadata, /^  generate-notes:/m);
  for (const output of [
    "state",
    "release-url",
    "notes-path",
    "notes-report",
    "notes-state",
  ]) {
    assert.match(metadata, new RegExp(`^  ${output}:`, "m"));
  }
});

test("runtime rejects Node versions below 24", () => {
  assert.doesNotThrow(() => requireNode24("24.0.0"));
  assert.doesNotThrow(() => requireNode24("26.1.0"));
  assert.throws(() => requireNode24("23.9.0"), /requires Node\.js 24/);
});

test("none mode prepares an empty body then invokes the publisher", async () => {
  const calls = [];
  const writes = [];
  await runAction({
    nodeVersion: "24.0.0",
    actionPath: "/action",
    env: baseEnv(),
    api: new FakeApi(null),
    appendOutput(path, data, options) {
      writes.push({ path, data, options });
    },
    spawnPublisher(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "bash");
  assert.deepEqual(calls[0].args, ["/action/scripts/release.sh"]);
  assert.equal(calls[0].options.cwd, "/workspace");
  assert.match(calls[0].options.env.INPUT_NOTES_FILE, /releaseway-notes-/);
  assert.equal(calls[0].options.env.RELEASE_ACTIONS_PRESERVE_BODY, "false");
  assert.match(writes[0].data, /notes-state=verified/);
});

test("preview prepares outputs and never invokes the publisher", async () => {
  const writes = [];
  let spawned = false;
  await runAction({
    nodeVersion: "24.0.0",
    actionPath: "/action",
    env: baseEnv({ INPUT_NOTES_PREVIEW: "true" }),
    api: new FakeApi(null),
    identityCheck() {},
    appendOutput(_path, data) {
      writes.push(data);
    },
    spawnPublisher() {
      spawned = true;
      return { status: 0 };
    },
  });

  assert.equal(spawned, false);
  assert.match(writes.join(""), /state=preview/);
  assert.match(writes.join(""), /notes-state=prepared/);
  assert.match(writes.join(""), /release-url=\n/);
});

test("published auto mode preserves observed body without generation", async () => {
  const body = "human edited notes\n";
  const release = {
    id: 42,
    tag: "v1.0.0",
    name: "v1.0.0",
    body,
    draft: false,
    prerelease: false,
    immutable: true,
    url: "https://example.invalid/release/42",
  };
  let generated = false;
  const api = new FakeApi(release);
  api.generateReleaseNotes = async () => {
    generated = true;
    return { name: "", body: "should not happen" };
  };
  const calls = [];
  const writes = [];

  await runAction({
    nodeVersion: "24.0.0",
    actionPath: "/action",
    env: baseEnv(),
    api,
    appendOutput(_path, data) {
      writes.push(data);
    },
    spawnPublisher(_command, _args, options) {
      calls.push(options);
      return { status: 0 };
    },
  });

  assert.equal(generated, false);
  assert.equal(calls[0].env.RELEASE_ACTIONS_PRESERVE_BODY, "true");
  assert.equal(calls[0].env.INPUT_NOTES_FILE, "");
  assert.match(
    calls[0].env.RELEASE_ACTIONS_ACCEPTED_BODY_FILE,
    /releaseway-notes-/,
  );
  assert.match(writes.join(""), /notes-state=preserved/);
});

test("committed engine bundle executes as CommonJS", () => {
  const output = execFileSync(
    process.execPath,
    [resolve("dist/engine.cjs"), "contract"],
    { encoding: "utf8" },
  );
  const contract = JSON.parse(output);
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.defaults.notes, "standard");
});
