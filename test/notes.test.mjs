import assert from "node:assert/strict";
import test from "node:test";

import { classifyChanges } from "../src/classify.ts";
import { parseConfigText, resolveConfig } from "../src/config.ts";
import { parseConventionalCommit } from "../src/conventional.ts";
import { commitRecord } from "../src/model.ts";
import { presetPolicy } from "../src/policy.ts";
import { renderReleaseNotes } from "../src/render.ts";
import { buildNotesReport } from "../src/report.ts";

const shas = {
  breaking: "1111111111111111111111111111111111111111",
  feature: "2222222222222222222222222222222222222222",
  fix: "3333333333333333333333333333333333333333",
  docs: "4444444444444444444444444444444444444444",
  other: "5555555555555555555555555555555555555555",
};

function evidence(sha, ordinal, message, authorName = "Alice") {
  return { sha, parents: [], message, authorName, ordinal };
}

function fixtureRecords() {
  return [
    commitRecord(
      evidence(
        shas.breaking,
        0,
        "feat(config)!: replace option format\n\nBREAKING CHANGE: use the new field names\nacross all configs",
      ),
    ),
    commitRecord(evidence(shas.feature, 1, "feat(cli): add validation command")),
    commitRecord(evidence(shas.fix, 2, "fix(upload): handle paths with spaces")),
    commitRecord(evidence(shas.docs, 3, "docs: clarify setup")),
    commitRecord(evidence(shas.other, 4, "adjust default message")),
  ];
}

function context() {
  return {
    repository: "releaseway/example",
    targetTag: "v1.5.0",
    targetSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseTag: "v1.4.2",
    baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    firstRelease: false,
  };
}

function range() {
  return {
    targetTag: "v1.5.0",
    targetSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseTag: "v1.4.2",
    baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    firstRelease: false,
    empty: false,
    strategy: "auto",
    ancestry: "first-parent",
    reason: "fixture",
  };
}

test("Conventional parser preserves scope, body, ! and multiline breaking footer", () => {
  const parsed = parseConventionalCommit(
    "feat(parser)!: change grammar\n\nBackground context\n\nBREAKING-CHANGE: migrate rule A\nthen rule B\nRefs: #123",
  );
  assert.equal(parsed.conventional, true);
  assert.equal(parsed.type, "feat");
  assert.equal(parsed.scope, "parser");
  assert.equal(parsed.description, "change grammar");
  assert.equal(parsed.breaking, true);
  assert.deepEqual(parsed.breakingDescriptions, ["migrate rule A\nthen rule B"]);
  assert.equal(parsed.body, "Background context");
});

test("nonconforming messages remain visible instead of being invented or dropped", () => {
  const record = commitRecord(evidence(shas.other, 0, "adjust default message"));
  const policy = presetPolicy("standard");
  assert.ok(policy);
  const classified = classifyChanges([record], policy);
  assert.equal(classified.included[0].category, "other");
  assert.equal(classified.included[0].title, "adjust default message");
  assert.deepEqual(classified.included[0].provenance, [
    "unclassified-message",
    "category:fallback:other",
  ]);
});

test("strict classification and explicit breaking exclusion are diagnosed", () => {
  const policy = presetPolicy("standard");
  assert.ok(policy);
  policy.classify.unknown = "error";
  assert.throws(
    () => classifyChanges([commitRecord(evidence(shas.other, 0, "plain message"))], policy),
    /could not classify/,
  );

  const filtered = presetPolicy("standard");
  assert.ok(filtered);
  filtered.filter.exclude.types = ["feat"];
  const result = classifyChanges(
    [commitRecord(evidence(shas.breaking, 0, "feat!: break api"))],
    filtered,
  );
  assert.equal(result.included.length, 0);
  assert.match(result.diagnostics[0], /breaking change excluded/);
});

test("configuration replaces arrays, merges fields and rejects unsupported combinations", () => {
  const document = parseConfigText(
    `version: 1
notes:
  source: hybrid
  range:
    strategy: previous-stable
    ancestry: reachable
    first-release: error
  classify:
    by: [labels, conventional]
    categories:
      - id: product
        title: Product
        labels: [product]
        types: [feat]
  filter:
    exclude:
      labels: [skip-changelog]
      types: []
      scopes: []
      authors: []
      bots: false
  render:
    layout: compact
    authors: false
    comparison: false
`,
    ".yml",
  );
  const resolved = resolveConfig("standard", document);
  assert.ok(resolved.policy);
  assert.equal(resolved.policy.source, "hybrid");
  assert.equal(resolved.policy.range.strategy, "previous-stable");
  assert.equal(resolved.policy.range.ancestry, "reachable");
  assert.equal(resolved.policy.range.firstRelease, "error");
  assert.deepEqual(resolved.policy.classify.by, ["labels", "conventional"]);
  assert.deepEqual(resolved.policy.classify.categories.map((c) => c.id), ["product"]);
  assert.deepEqual(resolved.policy.filter.exclude.labels, ["skip-changelog"]);
  assert.equal(resolved.policy.render.layout, "compact");
  assert.equal(resolved.policy.render.comparison, false);

  const invalid = parseConfigText(
    "version: 1\nnotes:\n  source: commits\n  classify:\n    by: [labels]\n",
    ".yml",
  );
  assert.throws(
    () => resolveConfig("standard", invalid),
    /commit-only source cannot use label/,
  );
  assert.throws(
    () => parseConfigText("version: 1\nnotes: {}\nextra: true\n", ".yml"),
    /config.extra is not supported/,
  );
});

test("all six custom layouts render the same selected record identities", () => {
  const records = fixtureRecords();
  const layouts = [
    "standard",
    "compact",
    "conventional",
    "changelog",
    "detailed",
    "scoped",
  ];
  for (const layout of layouts) {
    const policy = presetPolicy(layout);
    assert.ok(policy);
    const changes = classifyChanges(records, policy);
    const body = renderReleaseNotes(changes, policy, context());
    assert.ok(body.endsWith("\n"));
    assert.match(body, /Breaking Changes/);
    assert.match(body, /replace option format/);
    assert.match(body, /adjust default message/);
    for (const sha of Object.values(shas)) {
      assert.match(body, new RegExp(sha.slice(0, 7)));
    }
    assert.match(body, /Full Changelog/);
  }
});

test("standard output is deterministic and does not duplicate breaking changes", () => {
  const policy = presetPolicy("standard");
  assert.ok(policy);
  const changes = classifyChanges(fixtureRecords(), policy);
  const first = renderReleaseNotes(changes, policy, context());
  const second = renderReleaseNotes(changes, policy, context());
  assert.equal(first, second);
  assert.equal((first.match(/replace option format/g) ?? []).length, 1);
  assert.match(first, /## Features/);
  assert.match(first, /## Fixes/);
  assert.match(first, /## Documentation/);
  assert.match(first, /## Other Changes/);
});

test("report records included and excluded identities plus stable body digest", () => {
  const policy = presetPolicy("standard");
  assert.ok(policy);
  policy.filter.exclude.types = ["docs"];
  const changes = classifyChanges(fixtureRecords(), policy);
  const body = renderReleaseNotes(changes, policy, context());
  const report = buildNotesReport({
    body,
    changes,
    policy,
    range: range(),
  });
  assert.equal(report.version, 1);
  assert.equal(report.preset, "standard");
  assert.equal(report.included.length, 4);
  assert.equal(report.excluded.length, 1);
  assert.equal(report.excluded[0].id, `commit:${shas.docs}`);
  assert.equal(report.body.bytes, Buffer.byteLength(body, "utf8"));
  assert.match(report.body.sha256, /^[0-9a-f]{64}$/);
});

test("Markdown metacharacters are escaped and intentionally empty releases stay byte-empty", () => {
  const policy = presetPolicy("standard");
  assert.ok(policy);
  const record = commitRecord(
    evidence(shas.feature, 0, "feat(ui): add *literal* [text]"),
  );
  const body = renderReleaseNotes(
    classifyChanges([record], policy),
    policy,
    context(),
  );
  assert.match(body, /\\\*literal\\\*/);
  assert.match(body, /\\\[text\\\]/);

  assert.equal(
    renderReleaseNotes(
      classifyChanges([], policy),
      policy,
      { ...context(), intentionallyEmpty: true },
    ),
    "",
  );
});
