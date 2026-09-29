import type { CommitEvidence } from "./git.ts";
import {
  commitRecord,
  type ChangeRecord,
  type ClassifiedChanges,
} from "./model.ts";
import { parseConventionalCommit } from "./conventional.ts";
import type {
  GitHubApi,
  PullRequestAssociation,
} from "./github.ts";

export interface PullRequestCollection {
  records: ChangeRecord[];
  uncovered: CommitEvidence[];
  diagnostics: string[];
}

function pullRequestRecord(
  pr: PullRequestAssociation,
  commits: readonly CommitEvidence[],
): ChangeRecord {
  const parsed = parseConventionalCommit(pr.title);
  const ordered = [...commits].sort(
    (a, b) => a.ordinal - b.ordinal || a.sha.localeCompare(b.sha),
  );
  const commitFacts = ordered.map((commit) => commitRecord(commit));
  const breakingDescriptions = [
    ...new Set(
      commitFacts.flatMap((record) => record.breakingDescriptions),
    ),
  ];
  for (const description of parsed.breakingDescriptions) {
    if (!breakingDescriptions.includes(description)) {
      breakingDescriptions.push(description);
    }
  }
  return {
    id: `pull-request:${pr.number}`,
    source: "pull-request",
    ordinal: ordered[0]?.ordinal ?? 0,
    title: parsed.description,
    body: pr.body,
    author: pr.userLogin,
    isBot: pr.userType === "Bot" ? true : pr.userType ? false : null,
    type: parsed.type,
    scope: parsed.scope,
    labels: [...pr.labels],
    commitShas: ordered.map((commit) => commit.sha),
    pullRequest: pr.number,
    breaking:
      parsed.breaking ||
      commitFacts.some((record) => record.breaking),
    breakingDescriptions,
    security:
      parsed.type === "security" ||
      commitFacts.some((record) => record.security),
    deprecated:
      parsed.type === "deprecated" ||
      parsed.type === "deprecate" ||
      commitFacts.some((record) => record.deprecated),
    removed:
      parsed.type === "removed" ||
      parsed.type === "remove" ||
      commitFacts.some((record) => record.removed),
    category: null,
    categoryTitle: null,
    provenance: [
      "github:commit-pull-request-association",
      ...(parsed.conventional ? ["conventional-pr-title"] : []),
      ...(
        commitFacts.some((record) => record.breaking)
          ? ["breaking:covered-commit"]
          : []
      ),
    ],
  };
}

function samePullRequest(
  left: PullRequestAssociation,
  right: PullRequestAssociation,
): boolean {
  return (
    left.number === right.number &&
    left.title === right.title &&
    left.body === right.body &&
    left.mergedAt === right.mergedAt &&
    left.mergeCommitSha === right.mergeCommitSha &&
    left.baseRepository === right.baseRepository
  );
}

export async function collectPullRequestRecords(options: {
  repository: string;
  commits: readonly CommitEvidence[];
  api: GitHubApi;
}): Promise<PullRequestCollection> {
  const selectedShas = new Set(
    options.commits.map((commit) => commit.sha.toLowerCase()),
  );
  const assignments = new Map<
    number,
    {
      pr: PullRequestAssociation;
      commits: CommitEvidence[];
    }
  >();
  const uncovered = new Map(
    options.commits.map((commit) => [commit.sha, commit]),
  );
  const diagnostics: string[] = [];

  for (const commit of options.commits) {
    const associations = await options.api.associatedPullRequests(
      options.repository,
      commit.sha,
    );
    const merged = associations.filter(
      (pr) =>
        pr.baseRepository === options.repository &&
        pr.mergedAt.length > 0,
    );

    if (merged.length === 0) {
      diagnostics.push(
        `commit:${commit.sha}: no merged pull request association`,
      );
      continue;
    }
    if (merged.length > 1) {
      diagnostics.push(
        `commit:${commit.sha}: ambiguous merged pull request associations (${merged.map((pr) => pr.number).join(", ")})`,
      );
      continue;
    }

    const pr = merged[0]!;
    const existing = assignments.get(pr.number);
    if (existing && !samePullRequest(existing.pr, pr)) {
      throw new Error(
        `pull request #${pr.number} metadata changed during collection`,
      );
    }
    if (existing) {
      existing.commits.push(commit);
    } else {
      assignments.set(pr.number, { pr, commits: [commit] });
    }
  }

  const records: ChangeRecord[] = [];
  for (const { pr, commits } of assignments.values()) {
    if (!selectedShas.has(pr.mergeCommitSha)) {
      diagnostics.push(
        `pull-request:${pr.number}: merge commit ${pr.mergeCommitSha} is not in the released range; keeping associated commits uncovered`,
      );
      continue;
    }

    records.push(pullRequestRecord(pr, commits));
    for (const commit of commits) {
      uncovered.delete(commit.sha);
    }
  }

  records.sort(
    (a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id),
  );
  return {
    records,
    uncovered: [...uncovered.values()].sort(
      (a, b) => a.ordinal - b.ordinal || a.sha.localeCompare(b.sha),
    ),
    diagnostics,
  };
}

export function enforcePullRequestCoverage(options: {
  collection: PullRequestCollection;
  unmatched: "error" | "omit";
}): PullRequestCollection {
  if (
    options.unmatched === "error" &&
    options.collection.uncovered.length > 0
  ) {
    const diagnostics =
      options.collection.diagnostics.length > 0
        ? `; diagnostics: ${options.collection.diagnostics.join(" | ")}`
        : "";
    throw new Error(
      `pull-request source has ${options.collection.uncovered.length} uncovered released commit(s): ${options.collection.uncovered.map((commit) => commit.sha).join(", ")}${diagnostics}`,
    );
  }
  if (
    options.unmatched === "omit" &&
    options.collection.uncovered.length > 0
  ) {
    options.collection.diagnostics.push(
      `omitted ${options.collection.uncovered.length} uncovered released commit(s): ${options.collection.uncovered.map((commit) => commit.sha).join(", ")}`,
    );
  }
  return options.collection;
}

export function combineHybridRecords(options: {
  pullRequests: PullRequestCollection;
  commitRecords: readonly ChangeRecord[];
}): ChangeRecord[] {
  const uncovered = new Set(
    options.pullRequests.uncovered.map((commit) => commit.sha),
  );
  const commits = options.commitRecords.filter(
    (record) =>
      record.source === "commit" &&
      record.commitShas.some((sha) => uncovered.has(sha)),
  );
  return [...options.pullRequests.records, ...commits].sort(
    (a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id),
  );
}

export function appendProviderDiagnostics(
  changes: ClassifiedChanges,
  diagnostics: readonly string[],
): ClassifiedChanges {
  return {
    included: changes.included,
    excluded: changes.excluded,
    diagnostics: [...diagnostics, ...changes.diagnostics],
  };
}
