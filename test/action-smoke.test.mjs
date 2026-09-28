import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  requireNode24,
  runAction,
} from "../src/action.ts";

test("action metadata keeps composite token injection and exposes new notes contract", async () => {
  const metadata = await readFile(resolve("action.yml"), "utf8");

  assert.match(metadata, /using:\s*composite/);
  assert.match(
    metadata,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
  );
  assert.match(metadata, /node-version:\s*"24"/);
  assert.match(metadata, /node "\$GITHUB_ACTION_PATH\/dist\/main\.js"/);
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

test("scaffold invokes existing publisher for explicit none mode", () => {
  const calls = [];
  runAction({
    nodeVersion: "24.0.0",
    actionPath: "/action",
    env: {
      GITHUB_WORKSPACE: "/workspace",
      INPUT_NOTES: "none",
      INPUT_NOTES_EXISTING: "auto",
      INPUT_NOTES_PREVIEW: "false",
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
  assert.equal(calls[0].options.env.INPUT_NOTES, "none");
  assert.equal(calls[0].options.env.RELEASE_ACTIONS_ENGINE, "/action/dist/engine.js");
});

test("scaffold blocks modes whose implementation is not yet present", () => {
  assert.throws(
    () =>
      runAction({
        nodeVersion: "24.0.0",
        actionPath: "/action",
        env: { INPUT_NOTES: "standard" },
        spawnPublisher() {
          throw new Error("must not spawn");
        },
      }),
    /not available until release-note generation is implemented/,
  );
});
