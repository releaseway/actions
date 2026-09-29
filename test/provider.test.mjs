import assert from "node:assert/strict";
import test from "node:test";

import { GhCliApi } from "../src/github.ts";
import { commitRecord } from "../src/model.ts";
import {
  collectPullRequestRecords,
  combineHybridRecords,
  enforcePullRequestCoverage,
} from "../src/provider.ts";

function commit(sha, ordinal, message = "feat: change") {
  return { sha, parents: [], message, authorName: "Alice", ordinal };
}

function pr(number, mergeCommitSha, title = "feat(core): shipped") {
  return {
    number,
    title,
    body: "",
    mergedAt: "2026-09-28T00:00:00Z",
    mergeCommitSha,
    userLogin: "alice",
    userType: "User",
    labels: ["feature"],
    baseRepository: "releaseway/example",
  };
}

class FakeApi {
  constructor(associations) {
    this.associations = associations;
  }

  async associatedPullRequests(_repository, sha) {
    return this.associations.get(sha) ?? [];
  }

  async pullRequest(_repository, number) {
    for (const values of this.associations.values()) {
      const found = values.find((entry) => entry.number === number);
      if (found?.mergeCommitSha) return found;
    }
    throw new Error(`missing pull request #${number}`);
  }

  async generateReleaseNotes() {
    throw new Error("not used");
  }
}

test("ordinary merge coverage coalesces exactly associated released commits", async () => {
  const side = commit("1111111111111111111111111111111111111111", 0);
  const merge = commit("2222222222222222222222222222222222222222", 1);
  const association = pr(10, merge.sha);
  const result = await collectPullRequestRecords({
    repository: "releaseway/example",
    commits: [side, merge],
    api: new FakeApi(new Map([
      [side.sha, [association]],
      [merge.sha, [association]],
    ])),
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].pullRequest, 10);
  assert.deepEqual(result.records[0].commitShas, [side.sha, merge.sha]);
  assert.deepEqual(result.uncovered, []);
});

test("squash and rebase-shaped exact associations are accepted when landing commit is released", async () => {
  const squash = commit("3333333333333333333333333333333333333333", 0);
  const rebaseA = commit("4444444444444444444444444444444444444444", 1);
  const rebaseB = commit("5555555555555555555555555555555555555555", 2);
  const squashPr = pr(11, squash.sha, "fix: squash bug");
  const rebasePr = pr(12, rebaseB.sha, "feat(api): rebased work");

  const result = await collectPullRequestRecords({
    repository: "releaseway/example",
    commits: [squash, rebaseA, rebaseB],
    api: new FakeApi(new Map([
      [squash.sha, [squashPr]],
      [rebaseA.sha, [rebasePr]],
      [rebaseB.sha, [rebasePr]],
    ])),
  });

  assert.deepEqual(result.records.map((record) => record.pullRequest), [11, 12]);
  assert.deepEqual(result.records[1].commitShas, [rebaseA.sha, rebaseB.sha]);
  assert.deepEqual(result.uncovered, []);
});

test("cherry-picked or ambiguous associations remain uncovered instead of being guessed", async () => {
  const cherry = commit("6666666666666666666666666666666666666666", 0);
  const overlap = commit("7777777777777777777777777777777777777777", 1);
  const landingA = commit("8888888888888888888888888888888888888888", 2);
  const landingB = commit("9999999999999999999999999999999999999999", 3);
  const prA = pr(20, landingA.sha);
  const prB = pr(21, landingB.sha);

  const result = await collectPullRequestRecords({
    repository: "releaseway/example",
    commits: [cherry, overlap, landingA, landingB],
    api: new FakeApi(new Map([
      [overlap.sha, [prA, prB]],
      [landingA.sha, [prA]],
      [landingB.sha, [prB]],
    ])),
  });

  assert.deepEqual(
    result.uncovered.map((entry) => entry.sha),
    [cherry.sha, overlap.sha],
  );
  assert.match(result.diagnostics.join("\n"), /ambiguous merged pull request/);
});

test("covered commit breaking metadata survives PR coalescing", async () => {
  const breaking = commit(
    "abababababababababababababababababababab",
    0,
    "feat!: break api\n\nBREAKING CHANGE: migrate clients",
  );
  const landing = commit(
    "bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc",
    1,
    "merge branch",
  );
  const association = pr(25, landing.sha, "docs: describe release");
  const result = await collectPullRequestRecords({
    repository: "releaseway/example",
    commits: [breaking, landing],
    api: new FakeApi(new Map([
      [breaking.sha, [association]],
      [landing.sha, [association]],
    ])),
  });

  assert.equal(result.records[0].breaking, true);
  assert.deepEqual(
    result.records[0].breakingDescriptions,
    ["migrate clients"],
  );
  assert.match(
    result.records[0].provenance.join("\n"),
    /breaking:covered-commit/,
  );
});

test("PR-only error/omit and hybrid fallback preserve uncovered commits exactly once", async () => {
  const covered = commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 0);
  const landing = commit("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 1);
  const direct = commit("cccccccccccccccccccccccccccccccccccccccc", 2, "fix: direct");
  const association = pr(30, landing.sha);
  const collection = await collectPullRequestRecords({
    repository: "releaseway/example",
    commits: [covered, landing, direct],
    api: new FakeApi(new Map([
      [covered.sha, [association]],
      [landing.sha, [association]],
    ])),
  });

  assert.throws(
    () => enforcePullRequestCoverage({ collection, unmatched: "error" }),
    /1 uncovered released commit/,
  );

  const omitted = enforcePullRequestCoverage({
    collection: {
      records: [...collection.records],
      uncovered: [...collection.uncovered],
      diagnostics: [...collection.diagnostics],
    },
    unmatched: "omit",
  });
  assert.match(omitted.diagnostics.join("\n"), /omitted 1 uncovered/);

  const hybrid = combineHybridRecords({
    pullRequests: collection,
    commitRecords: [covered, landing, direct].map(commitRecord),
  });
  assert.deepEqual(
    hybrid.map((record) => record.id),
    ["pull-request:30", `commit:${direct.sha}`],
  );
});

test("PR coverage rejects association groups whose merge commit is outside the released range", async () => {
  const commitA = commit("dddddddddddddddddddddddddddddddddddddddd", 0);
  const association = pr(40, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  const result = await collectPullRequestRecords({
    repository: "releaseway/example",
    commits: [commitA],
    api: new FakeApi(new Map([[commitA.sha, [association]]])),
  });

  assert.deepEqual(result.records, []);
  assert.deepEqual(result.uncovered.map((entry) => entry.sha), [commitA.sha]);
  assert.match(result.diagnostics.join("\n"), /merge commit .* is not in the released range/);
});

test("GitHub CLI adapter preserves native generated body opaquely and sends explicit range/config", async () => {
  const calls = [];
  const api = new GhCliApi((args) => {
    calls.push([...args]);
    if (args.includes("releases/generate-notes") || args.some((arg) => arg.includes("/releases/generate-notes"))) {
      return JSON.stringify({
        name: "GitHub generated title",
        body: "## GitHub-owned heading\n\nopaque *markdown*\n",
      });
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        number: 51,
        title: "feat: x",
        body: "",
        mergedAt: "2026-09-28T00:00:00Z",
        mergeCommit: {
          oid: "ffffffffffffffffffffffffffffffffffffffff",
        },
        author: { login: "bot", is_bot: true },
        labels: [{ name: "feature" }],
      });
    }
    return JSON.stringify([{ number: 51 }]);
  });

  const associations = await api.associatedPullRequests(
    "releaseway/example",
    "ffffffffffffffffffffffffffffffffffffffff",
  );
  assert.equal(associations[0].number, 51);
  assert.equal(associations[0].userType, "Bot");
  assert.equal(
    associations[0].mergeCommitSha,
    "ffffffffffffffffffffffffffffffffffffffff",
  );

  const generated = await api.generateReleaseNotes({
    repository: "releaseway/example",
    tag: "v2.0.0",
    targetSha: "ffffffffffffffffffffffffffffffffffffffff",
    previousTag: "v1.0.0",
    configurationFile: ".github/release.yml",
  });
  assert.equal(
    generated.body,
    "## GitHub-owned heading\n\nopaque *markdown*\n",
  );
  assert.equal(generated.name, "GitHub generated title");

  const nativeArgs = calls.at(-1);
  assert.ok(nativeArgs.some((arg) => arg === "tag_name=v2.0.0"));
  assert.ok(nativeArgs.some((arg) => arg === "previous_tag_name=v1.0.0"));
  assert.ok(
    nativeArgs.some(
      (arg) => arg === "configuration_file_path=.github/release.yml",
    ),
  );
});
