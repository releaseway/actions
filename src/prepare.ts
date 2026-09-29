import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import { classifyChanges } from "./classify.ts";
import {
  parseConfigText,
  readConfigFile,
  resolveConfig,
} from "./config.ts";
import type { ActionInputs } from "./contract.ts";
import {
  collectCommitEvidence,
  createEvidenceRepository,
  verifyRemoteTagExists,
} from "./git.ts";
import {
  GhCliApi,
  type GitHubApi,
} from "./github.ts";
import { commitRecord, type ChangeRecord } from "./model.ts";
import {
  appendProviderDiagnostics,
  collectPullRequestRecords,
  combineHybridRecords,
  enforcePullRequestCoverage,
} from "./provider.ts";
import { renderReleaseNotes } from "./render.ts";
import { buildNotesReport, bodyDigest } from "./report.ts";
import { resolveRange } from "./range.ts";
import {
  assertNotesSize,
  assertSupportedText,
} from "./text.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface PreparedNotes {
  body: string;
  notesPath: string;
  reportPath: string;
  report: Record<string, unknown>;
}

export interface PrepareOptions {
  inputs: ActionInputs;
  repository: string;
  tag: string;
  commit: string;
  workspace: string;
  runnerTemp?: string;
  api?: GitHubApi;
}

export function withVisibleNotices(
  body: string,
  notices: readonly string[],
): string {
  if (notices.length === 0) return body;
  const noticeBlock = notices
    .map((notice) => `> **Note:** ${notice}`)
    .join("\n");
  return body
    ? noticeBlock + "\n\n" + body
    : noticeBlock + "\n";
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new Error(`${label} must contain valid UTF-8`);
  }
  assertSupportedText(text, label);
  assertNotesSize(text, label);
  return text;
}

function validatePreparedBody(
  body: string,
  label = "release notes",
): string {
  assertSupportedText(body, label);
  assertNotesSize(body, label);
  return body;
}

function digestText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function outputDirectory(tempRoot: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(join(tempRoot, "releaseway-notes-"));
}

async function writePrepared(
  output: string,
  body: string,
  report: Record<string, unknown>,
): Promise<PreparedNotes> {
  const notesPath = join(output, "notes.md");
  const reportPath = join(output, "notes-report.json");
  await writeFile(notesPath, Buffer.from(body, "utf8"));
  await writeFile(
    reportPath,
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
  return { body, notesPath, reportPath, report };
}

function simpleReport(options: {
  mode: string;
  body: string;
  status: string;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    version: 1,
    preset: options.mode,
    status: options.status,
    ...(options.details ?? {}),
    body: {
      sha256: digestText(options.body),
      bytes: Buffer.byteLength(options.body, "utf8"),
    },
  };
}

export async function observeExistingBody(options: {
  mode: string;
  body: string;
  runnerTemp?: string;
  releaseId: number;
  draft: boolean;
}): Promise<PreparedNotes> {
  const output = await outputDirectory(
    resolve(options.runnerTemp || tmpdir()),
  );
  return writePrepared(
    output,
    options.body,
    simpleReport({
      mode: options.mode,
      body: options.body,
      status: "preserved",
      details: {
        existingRelease: {
          id: options.releaseId,
          draft: options.draft,
        },
        generationEvaluated: false,
      },
    }),
  );
}

export async function prepareNotes(
  options: PrepareOptions,
): Promise<PreparedNotes> {
  const api = options.api ?? new GhCliApi();
  const output = await outputDirectory(
    resolve(options.runnerTemp || tmpdir()),
  );
  const mode = options.inputs.notes;

  if (mode === "file") {
    const bytes = await readFile(
      resolve(options.workspace, options.inputs.notesFile),
    );
    const body = decodeUtf8(bytes, "notes-file");
    return writePrepared(
      output,
      body,
      simpleReport({
        mode,
        body,
        status: "prepared",
        details: { source: "file" },
      }),
    );
  }

  if (mode === "none") {
    return writePrepared(
      output,
      "",
      simpleReport({
        mode,
        body: "",
        status: "prepared",
        details: { source: "none" },
      }),
    );
  }

  let configDocument = null;
  let configOrigin: Record<string, unknown> | null = null;
  if (options.inputs.notesConfig) {
    const loaded = await readConfigFile({
      inputPath: options.inputs.notesConfig,
      workspace: options.workspace,
      runnerTemp: options.runnerTemp,
    });
    configDocument = parseConfigText(
      loaded.text,
      extname(loaded.path).toLowerCase(),
    );
    configOrigin = {
      path: loaded.path,
      sha256: createHash("sha256")
        .update(loaded.text, "utf8")
        .digest("hex"),
    };
  }

  const resolved = resolveConfig(mode, configDocument);
  if (mode === "github") {
    if (resolved.github?.previousTag) {
      verifyRemoteTagExists({
        workspace: options.workspace,
        tag: resolved.github.previousTag,
      });
    }
    const generated = await api.generateReleaseNotes({
      repository: options.repository,
      tag: options.tag,
      targetSha: options.commit,
      previousTag: resolved.github?.previousTag,
      configurationFile: resolved.github?.configurationFile,
    });
    const body = validatePreparedBody(
      generated.body,
      "GitHub-generated release notes",
    );
    return writePrepared(
      output,
      body,
      simpleReport({
        mode,
        body,
        status: "prepared",
        details: {
          source: "github",
          config: configOrigin,
          github: resolved.github,
        },
      }),
    );
  }

  const policy = resolved.policy;
  if (!policy) {
    throw new Error(`notes mode ${mode} did not resolve a custom policy`);
  }

  const evidence = await createEvidenceRepository({
    workspace: options.workspace,
    tempRoot: options.runnerTemp || tmpdir(),
    targetTag: options.tag,
    expectedTargetSha: options.commit,
  });
  const published = await api.publishedReleases(options.repository);
  const range = resolveRange({
    repository: evidence.repository,
    targetTag: options.tag,
    targetSha: options.commit,
    releases: published,
    targetPrerelease: options.inputs.prerelease,
    policy: policy.range,
  });
  const commits = collectCommitEvidence(
    evidence.repository,
    range.targetSha,
    range.baseSha,
  );
  const commitRecords = commits.map(commitRecord);
  const transportMergeIds = new Set(
    commits.flatMap((commit, index) => {
      const record = commitRecords[index]!;
      return commit.parents.length > 1 &&
          record.type === null &&
          !record.breaking
        ? [record.id]
        : [];
    }),
  );
  const presentationCommitRecords = commitRecords.filter(
    (record) => !transportMergeIds.has(record.id),
  );
  let records: ChangeRecord[] = presentationCommitRecords;
  let providerDiagnostics: string[] =
    policy.source === "pull-requests"
      ? []
      : [...transportMergeIds].map(
          (id) => `${id}: omitted ordinary merge-summary transport record`,
        );
  const visibleNotices: string[] = [];

  if (policy.source !== "commits") {
    const collection = await collectPullRequestRecords({
      repository: options.repository,
      commits,
      api,
    });
    providerDiagnostics.push(...collection.diagnostics);
    if (policy.source === "pull-requests") {
      enforcePullRequestCoverage({
        collection,
        unmatched: policy.unmatched,
      });
      if (
        policy.unmatched === "omit" &&
        collection.uncovered.length > 0
      ) {
        visibleNotices.push(
          `${collection.uncovered.length} released commit(s) were omitted because they were not associated with a verified pull request.`,
        );
      }
      records = collection.records;
    } else {
      records = combineHybridRecords({
        pullRequests: collection,
        commitRecords: presentationCommitRecords,
      });
    }
  }

  let changes = classifyChanges(records, policy);
  for (const diagnostic of changes.diagnostics) {
    const match = diagnostic.match(
      /^(.*): breaking change excluded by explicit filter/,
    );
    if (match) {
      visibleNotices.push(
        `Breaking change ${match[1]} was excluded by an explicit filter.`,
      );
    }
  }
  changes = appendProviderDiagnostics(
    changes,
    providerDiagnostics,
  );
  let body = renderReleaseNotes(changes, policy, {
    repository: options.repository,
    targetTag: range.targetTag,
    targetSha: range.targetSha,
    baseTag: range.baseTag,
    baseSha: range.baseSha,
    firstRelease: range.firstRelease,
    intentionallyEmpty: range.empty && range.firstRelease,
  });
  body = withVisibleNotices(body, visibleNotices);
  validatePreparedBody(body);
  const report = buildNotesReport({
    body,
    changes,
    policy,
    range,
  }) as unknown as Record<string, unknown>;
  report.config = configOrigin;
  report.source = policy.source;

  return writePrepared(output, body, report);
}

export async function verifyReleaseBody(options: {
  repository: string;
  releaseId: number;
  expectedPath: string;
  api?: GitHubApi;
}): Promise<void> {
  const api = options.api ?? new GhCliApi();
  const bytes = await readFile(options.expectedPath);
  const expected = decodeUtf8(bytes, "prepared release notes");
  const actual = await api.releaseBody(
    options.repository,
    options.releaseId,
  );
  if (actual !== expected) {
    throw new Error(
      `existing release notes do not match requested notes: expected sha256=${bodyDigest(expected)} actual sha256=${bodyDigest(actual)}`,
    );
  }
}
