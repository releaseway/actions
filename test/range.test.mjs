import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  collectCommitEvidence,
  createEvidenceRepository,
  GitRepository,
  MAX_RELEASE_COMMITS,
  verifyRemoteTagBinding,
} from "../src/git.ts";
import {
  parseVersionedTag,
  resolveRange,
} from "../src/range.ts";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "releaseway-range-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "--bare", remote);
  git(root, "clone", remote, work);
  git(work, "config", "user.name", "Fixture");
  git(work, "config", "user.email", "fixture@example.invalid");

  async function commit(message, file) {
    await writeFile(join(work, file), message + "\n");
    git(work, "add", file);
    git(work, "commit", "--no-gpg-sign", "-m", message);
    return git(work, "rev-parse", "HEAD");
  }

  const rootSha = await commit("chore: root", "root.txt");
  git(work, "tag", "--no-sign", "v1.0.0");
  const featureSha = await commit("feat(api): add endpoint", "feature.txt");
  git(work, "tag", "--no-sign", "v1.1.0");
  const fixSha = await commit("fix: correct endpoint", "fix.txt");
  git(work, "tag", "--no-sign", "v1.2.0");
  git(work, "push", "origin", "HEAD:main", "--tags");

  return {
    root,
    remote,
    work,
    rootSha,
    featureSha,
    fixSha,
    repository: new GitRepository(work),
  };
}

test("versioned tags retain exact prefix family", () => {
  assert.equal(parseVersionedTag("v1.2.3")?.prefix, "v");
  assert.equal(parseVersionedTag("pkg-v1.2.3-beta.1")?.prefix, "pkg-v");
  assert.equal(parseVersionedTag("1.2.3")?.prefix, "");
  assert.equal(parseVersionedTag("release") ?? null, null);
});

test("auto selects nearest published stable release on first-parent history", async () => {
  const fixture = await repositoryFixture();
  const range = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.2.0",
    targetSha: fixture.fixSha,
    releases: [
      { tag: "v1.0.0", prerelease: false },
      { tag: "v1.1.0", prerelease: false },
    ],
  });

  assert.equal(range.baseTag, "v1.1.0");
  assert.equal(range.baseSha, fixture.featureSha);
  assert.equal(range.firstRelease, false);

  const commits = collectCommitEvidence(
    fixture.repository,
    fixture.fixSha,
    range.baseSha,
  );
  assert.deepEqual(commits.map((entry) => entry.sha), [fixture.fixSha]);
  assert.match(commits[0].message, /^fix: correct endpoint/);
});

test("auto ignores unpublished tags while previous-tag can select them", async () => {
  const fixture = await repositoryFixture();

  const auto = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.2.0",
    targetSha: fixture.fixSha,
    releases: [{ tag: "v1.0.0", prerelease: false }],
  });
  assert.equal(auto.baseTag, "v1.0.0");

  const previousTag = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.2.0",
    targetSha: fixture.fixSha,
    releases: [],
    policy: { strategy: "previous-tag" },
  });
  assert.equal(previousTag.baseTag, "v1.1.0");
});

test("first release all returns the complete deterministic reachable history", async () => {
  const fixture = await repositoryFixture();
  const range = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.2.0",
    targetSha: fixture.fixSha,
    releases: [],
  });
  assert.equal(range.firstRelease, true);
  assert.equal(range.baseSha, null);

  const commits = collectCommitEvidence(
    fixture.repository,
    fixture.fixSha,
    null,
  );
  assert.deepEqual(commits.map((entry) => entry.sha), [
    fixture.rootSha,
    fixture.featureSha,
    fixture.fixSha,
  ]);
  assert.deepEqual(commits.map((entry) => entry.ordinal), [0, 1, 2]);
});

test("first-release policy supports intentional empty and explicit-base-required modes", async () => {
  const fixture = await repositoryFixture();

  const empty = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.2.0",
    targetSha: fixture.fixSha,
    releases: [],
    policy: { firstRelease: "empty" },
  });
  assert.equal(empty.firstRelease, true);
  assert.equal(empty.empty, true);

  assert.throws(
    () =>
      resolveRange({
        repository: fixture.repository,
        targetTag: "v1.2.0",
        targetSha: fixture.fixSha,
        releases: [],
        policy: { firstRelease: "error" },
      }),
    /explicit base is required/,
  );
});

test("same-SHA release aliases choose the highest SemVer deterministically", async () => {
  const fixture = await repositoryFixture();
  git(fixture.work, "tag", "--no-sign", "v1.1.1", fixture.featureSha);

  const range = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.2.0",
    targetSha: fixture.fixSha,
    releases: [
      { tag: "v1.1.0", prerelease: false },
      { tag: "v1.1.1", prerelease: false },
    ],
  });
  assert.equal(range.baseTag, "v1.1.1");
  assert.equal(range.baseSha, fixture.featureSha);
});

test("explicit equal-SHA base is an intentional empty range", async () => {
  const fixture = await repositoryFixture();
  const range = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.2.0",
    targetSha: fixture.fixSha,
    releases: [],
    policy: { from: { commit: fixture.fixSha } },
  });
  assert.equal(range.empty, true);
  assert.deepEqual(
    collectCommitEvidence(fixture.repository, fixture.fixSha, range.baseSha),
    [],
  );
});

test("auto prerelease prefers the same prerelease identifier before stable", async () => {
  const fixture = await repositoryFixture();
  await writeFile(join(fixture.work, "pre.txt"), "beta1\n");
  git(fixture.work, "add", "pre.txt");
  git(fixture.work, "commit", "--no-gpg-sign", "-m", "feat: beta one");
  const beta1 = git(fixture.work, "rev-parse", "HEAD");
  git(fixture.work, "tag", "--no-sign", "v1.3.0-beta.1");

  await writeFile(join(fixture.work, "pre.txt"), "beta2\n");
  git(fixture.work, "commit", "--no-gpg-sign", "-am", "fix: beta two");
  const beta2 = git(fixture.work, "rev-parse", "HEAD");
  git(fixture.work, "tag", "--no-sign", "v1.3.0-beta.2");

  const range = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.3.0-beta.2",
    targetSha: beta2,
    releases: [
      { tag: "v1.2.0", prerelease: false },
      { tag: "v1.3.0-beta.1", prerelease: true },
    ],
  });
  assert.equal(range.baseTag, "v1.3.0-beta.1");
  assert.equal(range.baseSha, beta1);
});

test("first-parent policy rejects an eligible release that exists only on a merged side branch", async () => {
  const fixture = await repositoryFixture();
  git(fixture.work, "checkout", "-b", "side", "v1.1.0");
  await writeFile(join(fixture.work, "side.txt"), "side\n");
  git(fixture.work, "add", "side.txt");
  git(fixture.work, "commit", "--no-gpg-sign", "-m", "feat: side");
  git(fixture.work, "tag", "--no-sign", "v1.1.5");
  git(fixture.work, "checkout", "main");
  git(
    fixture.work,
    "merge",
    "--no-gpg-sign",
    "--no-ff",
    "side",
    "-m",
    "chore: merge side fixture",
  );
  const target = git(fixture.work, "rev-parse", "HEAD");
  git(fixture.work, "tag", "--no-sign", "v1.3.0");

  assert.throws(
    () =>
      resolveRange({
        repository: fixture.repository,
        targetTag: "v1.3.0",
        targetSha: target,
        releases: [{ tag: "v1.1.5", prerelease: false }],
      }),
    /none is on the target first-parent ancestry/,
  );

  const reachable = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.3.0",
    targetSha: target,
    releases: [{ tag: "v1.1.5", prerelease: false }],
    policy: { ancestry: "reachable" },
  });
  assert.equal(reachable.baseTag, "v1.1.5");
});

test("evidence repository fetches tags without mutating caller refs", async () => {
  const fixture = await repositoryFixture();
  const before = git(fixture.work, "show-ref", "--heads", "--tags");
  const evidence = await createEvidenceRepository({
    workspace: fixture.work,
    tempRoot: fixture.root,
    targetTag: "v1.2.0",
    expectedTargetSha: fixture.fixSha,
  });
  const after = git(fixture.work, "show-ref", "--heads", "--tags");

  assert.equal(before, after);
  assert.notEqual(evidence.path, fixture.work);
  assert.equal(evidence.targetSha, fixture.fixSha.toLowerCase());
  assert.equal(evidence.repository.resolveCommit("refs/tags/v1.1.0"), fixture.featureSha);
});

test("maintenance backport selects the nearest release on its own ancestry", async () => {
  const fixture = await repositoryFixture();
  git(fixture.work, "checkout", "-b", "maintenance", "v1.0.0");
  await writeFile(join(fixture.work, "patch.txt"), "one\n");
  git(fixture.work, "add", "patch.txt");
  git(fixture.work, "commit", "--no-gpg-sign", "-m", "fix: backport one");
  const patchOne = git(fixture.work, "rev-parse", "HEAD");
  git(fixture.work, "tag", "--no-sign", "v1.0.1");
  await writeFile(join(fixture.work, "patch.txt"), "two\n");
  git(fixture.work, "commit", "--no-gpg-sign", "-am", "fix: backport two");
  const patchTwo = git(fixture.work, "rev-parse", "HEAD");
  git(fixture.work, "tag", "--no-sign", "v1.0.2");

  const range = resolveRange({
    repository: fixture.repository,
    targetTag: "v1.0.2",
    targetSha: patchTwo,
    releases: [
      { tag: "v1.0.1", prerelease: false },
      { tag: "v1.1.0", prerelease: false },
    ],
  });
  assert.equal(range.baseTag, "v1.0.1");
  assert.equal(range.baseSha, patchOne);
});

test("reachable ancestry rejects incomparable maximal release bases", async () => {
  const fixture = await repositoryFixture();
  git(fixture.work, "checkout", "-b", "amb-left", "v1.0.0");
  await writeFile(join(fixture.work, "left.txt"), "left\n");
  git(fixture.work, "add", "left.txt");
  git(fixture.work, "commit", "--no-gpg-sign", "-m", "feat: left branch");
  git(fixture.work, "tag", "--no-sign", "amb-v1.1.0");

  git(fixture.work, "checkout", "-b", "amb-right", "v1.0.0");
  await writeFile(join(fixture.work, "right.txt"), "right\n");
  git(fixture.work, "add", "right.txt");
  git(fixture.work, "commit", "--no-gpg-sign", "-m", "feat: right branch");
  git(fixture.work, "tag", "--no-sign", "amb-v1.1.1");

  git(fixture.work, "checkout", "-b", "amb-target", "v1.0.0");
  git(
    fixture.work,
    "merge",
    "--no-gpg-sign",
    "--no-ff",
    "amb-left",
    "-m",
    "chore: merge left fixture",
  );
  git(
    fixture.work,
    "merge",
    "--no-gpg-sign",
    "--no-ff",
    "amb-right",
    "-m",
    "chore: merge right fixture",
  );
  const target = git(fixture.work, "rev-parse", "HEAD");
  git(fixture.work, "tag", "--no-sign", "amb-v1.2.0");

  assert.throws(
    () =>
      resolveRange({
        repository: fixture.repository,
        targetTag: "amb-v1.2.0",
        targetSha: target,
        releases: [
          { tag: "amb-v1.1.0", prerelease: false },
          { tag: "amb-v1.1.1", prerelease: false },
        ],
        policy: { ancestry: "reachable" },
      }),
    /reachable range candidates are ambiguous/,
  );
});

test("non-SemVer automatic release selection is allowed only with an explicit tag pattern", async () => {
  const fixture = await repositoryFixture();
  git(fixture.work, "tag", "--no-sign", "train-alpha", fixture.rootSha);
  git(fixture.work, "tag", "--no-sign", "train-beta", fixture.featureSha);
  git(fixture.work, "tag", "--no-sign", "train-gamma", fixture.fixSha);

  assert.throws(
    () =>
      resolveRange({
        repository: fixture.repository,
        targetTag: "train-gamma",
        targetSha: fixture.fixSha,
        releases: [{ tag: "train-beta", prerelease: false }],
      }),
    /requires tag-pattern/,
  );

  const range = resolveRange({
    repository: fixture.repository,
    targetTag: "train-gamma",
    targetSha: fixture.fixSha,
    releases: [
      { tag: "train-alpha", prerelease: false },
      { tag: "train-beta", prerelease: false },
    ],
    policy: { tagPattern: "train-*" },
  });
  assert.equal(range.baseTag, "train-beta");
  assert.equal(range.baseSha, fixture.featureSha);
});

test("explicit unrelated base is rejected", async () => {
  const fixture = await repositoryFixture();
  git(fixture.work, "checkout", "--orphan", "unrelated");
  git(fixture.work, "rm", "-rf", ".");
  await writeFile(join(fixture.work, "unrelated.txt"), "unrelated\n");
  git(fixture.work, "add", "unrelated.txt");
  git(fixture.work, "commit", "--no-gpg-sign", "-m", "chore: unrelated history");
  const unrelated = git(fixture.work, "rev-parse", "HEAD");
  git(fixture.work, "checkout", "main");

  assert.throws(
    () =>
      resolveRange({
        repository: fixture.repository,
        targetTag: "v1.2.0",
        targetSha: fixture.fixSha,
        releases: [],
        policy: { from: { commit: unrelated } },
      }),
    /not an ancestor/,
  );
});

test("evidence collection is independent of caller HEAD and shallow history", async () => {
  const fixture = await repositoryFixture();
  git(fixture.work, "checkout", "--detach", "v1.0.0");
  const detached = await createEvidenceRepository({
    workspace: fixture.work,
    tempRoot: fixture.root,
    targetTag: "v1.2.0",
    expectedTargetSha: fixture.fixSha,
  });
  assert.equal(detached.targetSha, fixture.fixSha.toLowerCase());
  assert.equal(
    detached.repository.resolveCommit("refs/tags/v1.0.0"),
    fixture.rootSha,
  );

  const shallow = join(fixture.root, "shallow");
  git(
    fixture.root,
    "clone",
    "--depth",
    "1",
    "--branch",
    "main",
    "file://" + fixture.remote,
    shallow,
  );
  const shallowEvidence = await createEvidenceRepository({
    workspace: shallow,
    tempRoot: fixture.root,
    targetTag: "v1.2.0",
    expectedTargetSha: fixture.fixSha,
  });
  assert.equal(
    shallowEvidence.repository.resolveCommit("refs/tags/v1.0.0"),
    fixture.rootSha,
  );
});


test("evidence fetch uses checkout auth transiently without persisting secrets", async () => {
  const fixture = await repositoryFixture();
  git(
    fixture.work,
    "config",
    "--local",
    "http.https://github.com/.extraheader",
    "AUTHORIZATION: basic fixture-token",
  );

  const evidence = await createEvidenceRepository({
    workspace: fixture.work,
    tempRoot: fixture.root,
    targetTag: "v1.2.0",
    expectedTargetSha: fixture.fixSha,
  });

  const persisted = evidence.repository.run(
    [
      "config",
      "--local",
      "--get",
      "http.https://github.com/.extraheader",
    ],
    true,
  );
  assert.equal(persisted.status, 1);
});

test("remote tag binding is enforced independently of notes mode", async () => {
  const fixture = await repositoryFixture();
  assert.equal(
    verifyRemoteTagBinding({
      workspace: fixture.work,
      tag: "v1.2.0",
      expectedCommit: fixture.fixSha,
    }),
    fixture.fixSha,
  );
  assert.throws(
    () =>
      verifyRemoteTagBinding({
        workspace: fixture.work,
        tag: "v1.2.0",
        expectedCommit: fixture.featureSha,
      }),
    /release tag target does not match commit/,
  );
});

test("automatic SemVer channel rejects contradictory prerelease state", async () => {
  const fixture = await repositoryFixture();
  await writeFile(join(fixture.work, "beta.txt"), "beta\n");
  git(fixture.work, "add", "beta.txt");
  git(fixture.work, "commit", "--no-gpg-sign", "-m", "feat: beta");
  const beta = git(fixture.work, "rev-parse", "HEAD");
  git(fixture.work, "tag", "--no-sign", "v1.3.0-beta.1");

  assert.throws(
    () =>
      resolveRange({
        repository: fixture.repository,
        targetTag: "v1.3.0-beta.1",
        targetSha: beta,
        targetPrerelease: false,
        releases: [{ tag: "v1.2.0", prerelease: false }],
      }),
    /prerelease classification conflicts/,
  );
});

test("non-SemVer automatic selection uses requested prerelease state", async () => {
  const fixture = await repositoryFixture();
  git(fixture.work, "tag", "--no-sign", "train-stable", fixture.rootSha);
  git(fixture.work, "tag", "--no-sign", "train-rc1", fixture.featureSha);
  git(fixture.work, "tag", "--no-sign", "train-rc2", fixture.fixSha);

  const prerelease = resolveRange({
    repository: fixture.repository,
    targetTag: "train-rc2",
    targetSha: fixture.fixSha,
    targetPrerelease: true,
    releases: [
      { tag: "train-stable", prerelease: false },
      { tag: "train-rc1", prerelease: true },
    ],
    policy: { tagPattern: "train-*" },
  });
  assert.equal(prerelease.baseTag, "train-rc1");

  const stable = resolveRange({
    repository: fixture.repository,
    targetTag: "train-rc2",
    targetSha: fixture.fixSha,
    targetPrerelease: false,
    releases: [
      { tag: "train-stable", prerelease: false },
      { tag: "train-rc1", prerelease: true },
    ],
    policy: { tagPattern: "train-*" },
  });
  assert.equal(stable.baseTag, "train-stable");
});

test("release history collection fails before materializing an oversized graph", () => {
  const repository = {
    run(args) {
      if (args[0] === "rev-list" && args[1] === "--count") {
        return { stdout: String(MAX_RELEASE_COMMITS + 1), status: 0 };
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  };
  assert.throws(
    () =>
      collectCommitEvidence(
        repository,
        "a".repeat(40),
        null,
      ),
    /exceeds maximum commit count/,
  );
});
