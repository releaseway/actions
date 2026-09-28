import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  observeExistingBody,
  prepareNotes,
  verifyReleaseBody,
} from "../src/prepare.ts";

class FakeApi {
  constructor(body = "") {
    this.body = body;
  }

  async releaseBody() {
    return this.body;
  }

  async releaseByTag() {
    return null;
  }

  async publishedReleases() {
    return [];
  }

  async associatedPullRequests() {
    return [];
  }

  async generateReleaseNotes() {
    return { name: "native", body: this.body };
  }
}

function inputs(overrides = {}) {
  return {
    notes: "none",
    notesConfig: "",
    notesFile: "",
    notesExisting: "auto",
    notesPreview: false,
    ...overrides,
  };
}

test("file preparation preserves valid UTF-8 bytes including final-newline choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-file-"));
  const cases = [
    "literal *markdown* 한글\n",
    "no final newline",
  ];
  for (const [index, body] of cases.entries()) {
    const path = join(root, `notes-${index}.md`);
    await writeFile(path, Buffer.from(body, "utf8"));
    const prepared = await prepareNotes({
      inputs: inputs({ notes: "file", notesFile: path }),
      repository: "releaseway/example",
      tag: "v1.0.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      workspace: root,
      runnerTemp: root,
      api: new FakeApi(),
    });
    assert.equal(prepared.body, body);
    assert.deepEqual(await readFile(prepared.notesPath), Buffer.from(body));
  }
});

test("file preparation rejects invalid UTF-8", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-file-invalid-"));
  const path = join(root, "notes.md");
  await writeFile(path, Buffer.from([0xff, 0xfe]));
  await assert.rejects(
    () =>
      prepareNotes({
        inputs: inputs({ notes: "file", notesFile: path }),
        repository: "releaseway/example",
        tag: "v1.0.0",
        commit: "0123456789abcdef0123456789abcdef01234567",
        workspace: root,
        runnerTemp: root,
        api: new FakeApi(),
      }),
    /valid UTF-8/,
  );
});

test("exact body verification preserves trailing newline semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-body-"));
  const expected = join(root, "expected.md");
  await writeFile(expected, "same body\n", "utf8");

  await verifyReleaseBody({
    repository: "releaseway/example",
    releaseId: 42,
    expectedPath: expected,
    api: new FakeApi("same body\n"),
  });

  await assert.rejects(
    () =>
      verifyReleaseBody({
        repository: "releaseway/example",
        releaseId: 42,
        expectedPath: expected,
        api: new FakeApi("same body"),
      }),
    /do not match requested notes/,
  );
});

test("preserved body output records that generation was not evaluated", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-preserve-"));
  const prepared = await observeExistingBody({
    mode: "standard",
    body: "edited remotely\n",
    runnerTemp: root,
    releaseId: 42,
    draft: false,
  });
  assert.equal(
    (await readFile(prepared.notesPath, "utf8")),
    "edited remotely\n",
  );
  const report = JSON.parse(
    await readFile(prepared.reportPath, "utf8"),
  );
  assert.equal(report.status, "preserved");
  assert.equal(report.generationEvaluated, false);
  assert.equal(report.existingRelease.id, 42);
});
