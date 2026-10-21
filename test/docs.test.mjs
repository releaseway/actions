import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  NOTES_EXISTING_POLICIES,
  NOTES_MODES,
} from "../src/contract.ts";

test("Publishing guide documents every public release-note mode and lifecycle policy", async () => {
  const guide = (await readFile(resolve("docs/publishing.md"), "utf8"))
    .replace(/\s+/g, " ");

  for (const mode of NOTES_MODES) {
    assert.ok(
      guide.includes(`\`${mode}\``),
      `Publishing guide is missing notes mode ${mode}`,
    );
  }
  for (const policy of NOTES_EXISTING_POLICIES) {
    assert.ok(
      guide.includes(`\`${policy}\``),
      `Publishing guide is missing notes-existing policy ${policy}`,
    );
  }

  for (const layout of [
    "standard",
    "compact",
    "conventional",
    "changelog",
    "detailed",
    "scoped",
  ]) {
    assert.match(
      guide,
      new RegExp(`\\\`${layout}\\\``),
      `Publishing guide preset gallery is missing ${layout}`,
    );
  }
});

test("Publishing guide input and output tables cover action metadata", async () => {
  const [metadataText, guide] = await Promise.all([
    readFile(resolve("action.yml"), "utf8"),
    readFile(resolve("docs/publishing.md"), "utf8"),
  ]);
  const metadata = parse(metadataText);

  for (const input of Object.keys(metadata.inputs ?? {})) {
    assert.ok(
      new RegExp(`^\\s*\\|\\s*\`${input}\`\\s*\\|`, "m").test(guide),
      `Publishing guide input table is missing ${input}`,
    );
  }
  for (const output of Object.keys(metadata.outputs ?? {})) {
    assert.ok(
      new RegExp(`^\\s*\\|\\s*\`${output}\`\\s*\\|`, "m").test(guide),
      `Publishing guide output table is missing ${output}`,
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
