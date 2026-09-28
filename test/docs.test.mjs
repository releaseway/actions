import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  NOTES_EXISTING_POLICIES,
  NOTES_MODES,
} from "../src/contract.ts";

test("README documents every public release-note mode and lifecycle policy", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");

  for (const mode of NOTES_MODES) {
    assert.ok(
      readme.includes(`\`${mode}\``),
      `README is missing notes mode ${mode}`,
    );
  }
  for (const policy of NOTES_EXISTING_POLICIES) {
    assert.ok(
      readme.includes(`\`${policy}\``),
      `README is missing notes-existing policy ${policy}`,
    );
  }

  assert.match(readme, /Early 0\.x contract break/);
  assert.match(readme, /old boolean `generate-notes` input is removed/);
  assert.match(readme, /GitHub-native preview\/generation \| `contents: write`/);
  assert.match(readme, /PR\/hybrid preview \| `contents: read`, `pull-requests: read`/);
});

test("README input and output tables cover action metadata", async () => {
  const [metadataText, readme] = await Promise.all([
    readFile(resolve("action.yml"), "utf8"),
    readFile(resolve("README.md"), "utf8"),
  ]);
  const metadata = parse(metadataText);

  for (const input of Object.keys(metadata.inputs ?? {})) {
    assert.ok(
      readme.includes(`| \`${input}\` |`),
      `README input table is missing ${input}`,
    );
  }
  for (const output of Object.keys(metadata.outputs ?? {})) {
    assert.ok(
      readme.includes(`| \`${output}\` |`),
      `README output table is missing ${output}`,
    );
  }

  assert.equal(metadata.inputs["generate-notes"], undefined);
  assert.equal(metadata.inputs.notes.default, "standard");
});

test("self-release workflow explicitly adopts standard generated notes", async () => {
  const workflow = await readFile(
    resolve(".github/workflows/release.yml"),
    "utf8",
  );

  assert.match(workflow, /notes:\s*standard/);
  assert.match(
    workflow,
    /steps\.publish\.outputs\.notes-state/,
  );
});
