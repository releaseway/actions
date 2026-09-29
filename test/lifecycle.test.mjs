import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  observeExistingBody,
  prepareNotes,
  verifyReleaseBody,
  withVisibleNotices,
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
    prerelease: false,
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

test("visible omission notices are rendered into the release body", () => {
  const body = withVisibleNotices(
    "## Changes\n\n- retained\n",
    ["1 released commit(s) were omitted because they were not associated with a verified pull request."],
  );
  assert.match(body, /^> \*\*Note:\*\*/);
  assert.match(body, /1 released commit\(s\) were omitted/);
  assert.match(body, /## Changes/);
  assert.ok(body.endsWith("\n"));
});
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

test("pull-request omit mode exposes omission in the prepared body and report", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-pr-omit-"));
  const origin = join(root, "origin.git");
  const workspace = join(root, "work");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["init", "-b", "main", workspace]);
  git(workspace, "config", "user.email", "fixture@example.invalid");
  git(workspace, "config", "user.name", "Fixture");
  git(workspace, "config", "commit.gpgsign", "false");
  git(workspace, "config", "tag.gpgSign", "false");
  git(workspace, "config", "core.hooksPath", "/dev/null");
  git(workspace, "remote", "add", "origin", origin);

  await writeFile(join(workspace, "base.txt"), "base\n");
  git(workspace, "add", "base.txt");
  git(workspace, "commit", "-m", "chore: base");
  const baseline = git(workspace, "rev-parse", "HEAD");

  await writeFile(join(workspace, "covered.txt"), "covered\n");
  git(workspace, "add", "covered.txt");
  git(workspace, "commit", "-m", "feat(core): covered");
  const covered = git(workspace, "rev-parse", "HEAD");

  await writeFile(join(workspace, "landing.txt"), "landing\n");
  git(workspace, "add", "landing.txt");
  git(workspace, "commit", "-m", "chore: landing");
  const landing = git(workspace, "rev-parse", "HEAD");

  await writeFile(join(workspace, "direct.txt"), "direct\n");
  git(workspace, "add", "direct.txt");
  git(workspace, "commit", "-m", "fix: direct");
  const direct = git(workspace, "rev-parse", "HEAD");
  git(workspace, "update-ref", "refs/tags/notes-test-v1.0.0", "HEAD");
  git(workspace, "push", "origin", "main", "refs/tags/notes-test-v1.0.0");

  const configPath = join(root, "notes.yml");
  await writeFile(
    configPath,
    `version: 1
notes:
  range:
    from:
      commit: ${baseline}
  unmatched: omit
`,
    "utf8",
  );

  const association = {
    number: 1,
    title: "feat(core): covered PR",
    body: "",
    mergedAt: "2026-09-28T00:00:00Z",
    mergeCommitSha: landing,
    userLogin: "alice",
    userType: "User",
    labels: ["enhancement"],
    baseRepository: "releaseway/example",
  };
  const api = new FakeApi();
  api.associatedPullRequests = async (_repository, sha) =>
    sha === covered || sha === landing ? [association] : [];

  const prepared = await prepareNotes({
    inputs: inputs({
      notes: "pull-requests",
      notesConfig: configPath,
    }),
    repository: "releaseway/example",
    tag: "notes-test-v1.0.0",
    commit: direct,
    workspace,
    runnerTemp: root,
    api,
  });

  assert.match(prepared.body, /^> \*\*Note:\*\*/);
  assert.match(prepared.body, /1 released commit\(s\) were omitted/);
  assert.match(prepared.body, /#1/);
  const report = JSON.parse(await readFile(prepared.reportPath, "utf8"));
  assert.deepEqual(report.included.map((entry) => entry.id), [
    "pull-request:1",
  ]);
  assert.match(report.diagnostics.join("\n"), new RegExp(direct));
});


test("commit notes omit ordinary merge-summary transport records with diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-merge-summary-"));
  const origin = join(root, "origin.git");
  const workspace = join(root, "work");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["init", "-b", "main", workspace]);
  git(workspace, "config", "user.email", "fixture@example.invalid");
  git(workspace, "config", "user.name", "Fixture");
  git(workspace, "config", "commit.gpgsign", "false");
  git(workspace, "config", "tag.gpgSign", "false");
  git(workspace, "config", "core.hooksPath", "/dev/null");
  git(workspace, "remote", "add", "origin", origin);

  await writeFile(join(workspace, "base.txt"), "base\n");
  git(workspace, "add", "base.txt");
  git(workspace, "commit", "-m", "chore: base");
  git(workspace, "tag", "v1.0.0");
  const base = git(workspace, "rev-parse", "HEAD");

  git(workspace, "checkout", "-b", "side");
  await writeFile(join(workspace, "feature.txt"), "feature\n");
  git(workspace, "add", "feature.txt");
  git(workspace, "commit", "-m", "feat(core): side feature");
  const feature = git(workspace, "rev-parse", "HEAD");

  git(workspace, "checkout", "main");
  git(workspace, "merge", "--no-ff", "side", "-m", "Merge branch 'side'");
  const merge = git(workspace, "rev-parse", "HEAD");
  git(workspace, "tag", "v1.1.0");
  git(workspace, "push", "origin", "main", "--tags");

  const api = new FakeApi();
  api.publishedReleases = async () => [
    { tag: "v1.0.0", draft: false, prerelease: false },
  ];

  const prepared = await prepareNotes({
    inputs: inputs({ notes: "standard" }),
    repository: "releaseway/example",
    tag: "v1.1.0",
    commit: merge,
    workspace,
    runnerTemp: root,
    api,
  });

  assert.match(prepared.body, /side feature/);
  assert.doesNotMatch(prepared.body, /Merge branch/);
  const report = JSON.parse(await readFile(prepared.reportPath, "utf8"));
  assert.deepEqual(report.included.map((entry) => entry.id), [
    `commit:${feature}`,
  ]);
  assert.match(
    report.diagnostics.join("\n"),
    new RegExp(`commit:${merge}: omitted ordinary merge-summary transport record`),
  );
  assert.equal(report.range.baseSha, base);
});

test("explicitly filtered breaking changes produce a visible body notice", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-breaking-filter-"));
  const origin = join(root, "origin.git");
  const workspace = join(root, "work");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["init", "-b", "main", workspace]);
  git(workspace, "config", "user.email", "fixture@example.invalid");
  git(workspace, "config", "user.name", "Fixture");
  git(workspace, "config", "commit.gpgsign", "false");
  git(workspace, "config", "tag.gpgSign", "false");
  git(workspace, "config", "core.hooksPath", "/dev/null");
  git(workspace, "remote", "add", "origin", origin);

  await writeFile(join(workspace, "base.txt"), "base\n");
  git(workspace, "add", "base.txt");
  git(workspace, "commit", "-m", "chore: base");
  const base = git(workspace, "rev-parse", "HEAD");

  await writeFile(join(workspace, "breaking.txt"), "breaking\n");
  git(workspace, "add", "breaking.txt");
  git(workspace, "commit", "-m", "feat!: remove old API");
  const breaking = git(workspace, "rev-parse", "HEAD");
  git(workspace, "tag", "v1.0.0");
  git(workspace, "push", "origin", "main", "--tags");

  const configPath = join(root, "filter.yml");
  await writeFile(
    configPath,
    `version: 1
notes:
  range:
    from:
      commit: ${base}
  filter:
    exclude:
      types: [feat]
`,
    "utf8",
  );

  const prepared = await prepareNotes({
    inputs: inputs({
      notes: "standard",
      notesConfig: configPath,
    }),
    repository: "releaseway/example",
    tag: "v1.0.0",
    commit: breaking,
    workspace,
    runnerTemp: root,
    api: new FakeApi(),
  });

  assert.match(
    prepared.body,
    new RegExp(`^> \\*\\*Note:\\*\\* Breaking change commit:${breaking} was excluded by an explicit filter\\.`),
  );
  const report = JSON.parse(await readFile(prepared.reportPath, "utf8"));
  assert.equal(report.excluded[0].id, `commit:${breaking}`);
  assert.equal(report.excluded[0].breaking, true);
});

test("GitHub native mode validates previous tag and returned text before output", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-native-validation-"));
  const origin = join(root, "origin.git");
  const workspace = join(root, "work");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["init", "-b", "main", workspace]);
  git(workspace, "config", "user.email", "fixture@example.invalid");
  git(workspace, "config", "user.name", "Fixture");
  git(workspace, "config", "commit.gpgsign", "false");
  git(workspace, "config", "tag.gpgSign", "false");
  git(workspace, "config", "core.hooksPath", "/dev/null");
  git(workspace, "remote", "add", "origin", origin);
  await writeFile(join(workspace, "release.txt"), "release\n");
  git(workspace, "add", "release.txt");
  git(workspace, "commit", "-m", "feat: release");
  const target = git(workspace, "rev-parse", "HEAD");
  git(workspace, "tag", "v1.0.0");
  git(workspace, "push", "origin", "main", "--tags");

  const configPath = join(root, "native.yml");
  await writeFile(
    configPath,
    "version: 1\nnotes:\n  github:\n    previous-tag: v0.9.0\n",
    "utf8",
  );

  let generated = false;
  const api = new FakeApi();
  api.generateReleaseNotes = async () => {
    generated = true;
    return { name: "ignored", body: "generated\n" };
  };

  await assert.rejects(
    () =>
      prepareNotes({
        inputs: inputs({
          notes: "github",
          notesConfig: configPath,
        }),
        repository: "releaseway/example",
        tag: "v1.0.0",
        commit: target,
        workspace,
        runnerTemp: root,
        api,
      }),
    /release tag is missing from origin: v0\.9\.0/,
  );
  assert.equal(generated, false);

  api.generateReleaseNotes = async () => ({
    name: "ignored",
    body: "unsafe \u001bbody",
  });
  await assert.rejects(
    () =>
      prepareNotes({
        inputs: inputs({ notes: "github" }),
        repository: "releaseway/example",
        tag: "v1.0.0",
        commit: target,
        workspace,
        runnerTemp: root,
        api,
      }),
    /unsupported control characters/,
  );
});
