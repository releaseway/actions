import type { CommitEvidence } from "./git.ts";
import { parseConventionalCommit } from "./conventional.ts";

export type ChangeSourceKind = "commit" | "pull-request";

export interface ChangeRecord {
  id: string;
  source: ChangeSourceKind;
  ordinal: number;
  title: string;
  body: string;
  author: string | null;
  isBot: boolean | null;
  type: string | null;
  scope: string | null;
  labels: string[];
  commitShas: string[];
  pullRequest: number | null;
  breaking: boolean;
  breakingDescriptions: string[];
  security: boolean;
  deprecated: boolean;
  removed: boolean;
  category: string | null;
  categoryTitle: string | null;
  provenance: string[];
}

export interface ClassifiedChanges {
  included: ChangeRecord[];
  excluded: Array<{
    record: ChangeRecord;
    reasons: string[];
  }>;
  diagnostics: string[];
}

export function commitRecord(
  evidence: CommitEvidence,
): ChangeRecord {
  const parsed = parseConventionalCommit(evidence.message);
  return {
    id: `commit:${evidence.sha}`,
    source: "commit",
    ordinal: evidence.ordinal,
    title: parsed.description,
    body: parsed.body,
    author: evidence.authorName || null,
    isBot: null,
    type: parsed.type,
    scope: parsed.scope,
    labels: [],
    commitShas: [evidence.sha],
    pullRequest: null,
    breaking: parsed.breaking,
    breakingDescriptions: [...parsed.breakingDescriptions],
    security: parsed.type === "security",
    deprecated:
      parsed.type === "deprecated" ||
      parsed.type === "deprecate",
    removed:
      parsed.type === "removed" ||
      parsed.type === "remove",
    category: null,
    categoryTitle: null,
    provenance: parsed.conventional
      ? ["conventional"]
      : ["unclassified-message"],
  };
}
