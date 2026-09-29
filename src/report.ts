import { createHash } from "node:crypto";

import type { ClassifiedChanges } from "./model.ts";
import type { EffectiveNotesPolicy } from "./policy.ts";
import type { RangeResolution } from "./range.ts";

export interface NotesReport {
  version: 1;
  preset: string;
  status: "prepared";
  metadata: {
    pullRequestMetadataMutable: boolean;
    rangeSelectionMutable: boolean;
  };
  effectivePolicy: EffectiveNotesPolicy;
  range: RangeResolution;
  included: Array<{
    id: string;
    source: string;
    commits: string[];
    pullRequest: number | null;
    category: string | null;
    breaking: boolean;
  }>;
  excluded: Array<{
    id: string;
    reasons: string[];
    breaking: boolean;
  }>;
  diagnostics: string[];
  body: {
    sha256: string;
    bytes: number;
  };
}

export function bodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function buildNotesReport(options: {
  body: string;
  changes: ClassifiedChanges;
  policy: EffectiveNotesPolicy;
  range: RangeResolution;
}): NotesReport {
  return {
    version: 1,
    preset: options.policy.preset,
    status: "prepared",
    metadata: {
      pullRequestMetadataMutable:
        options.policy.source !== "commits",
      rangeSelectionMutable:
        options.policy.range.from === undefined ||
        "tag" in options.policy.range.from,
    },
    effectivePolicy: options.policy,
    range: options.range,
    included: options.changes.included.map((record) => ({
      id: record.id,
      source: record.source,
      commits: [...record.commitShas],
      pullRequest: record.pullRequest,
      category: record.category,
      breaking: record.breaking,
    })),
    excluded: options.changes.excluded.map(({ record, reasons }) => ({
      id: record.id,
      reasons: [...reasons],
      breaking: record.breaking,
    })),
    diagnostics: [...options.changes.diagnostics],
    body: {
      sha256: bodyDigest(options.body),
      bytes: Buffer.byteLength(options.body, "utf8"),
    },
  };
}
