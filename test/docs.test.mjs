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
  const guide = await readFile(resolve("docs/publishing.md"), "utf8");

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

  assert.match(guide, /Early 0\.x contract break/);
  assert.match(guide, /old boolean `generate-notes` input is removed/);
  assert.match(guide, /GitHub-native preview\/generation \| `contents: write`/);
  assert.match(guide, /PR\/hybrid preview \| `contents: read`, `pull-requests: read`/);
  assert.match(guide, /### Preset gallery/);
  assert.match(guide, /### Input combinations/);
  assert.match(guide, /at most 10,000 commits/);
  assert.match(guide, /at most 1 MiB of UTF-8 text/);
  assert.match(guide, /when `title` is omitted, the existing published title is preserved/);
  assert.match(guide, /Open or closed-unmerged associations are ignored for coverage/);
  assert.match(guide, /HTTP authorization header is forwarded only to the isolated fetch subprocess/);
  assert.match(guide, /metadata-mutability flags/);
  assert.match(guide, /contradictory metadata fails instead of being silently reclassified/);
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
      new RegExp(`\\| \\\`${layout}\\\` \\\|`),
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
      guide.includes(`| \`${input}\` |`),
      `Publishing guide input table is missing ${input}`,
    );
  }
  for (const output of Object.keys(metadata.outputs ?? {})) {
    assert.ok(
      guide.includes(`| \`${output}\` |`),
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
