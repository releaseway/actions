import type { EffectiveNotesPolicy } from "./policy.ts";
import type {
  ChangeRecord,
  ClassifiedChanges,
} from "./model.ts";

function matchesCategory(
  record: ChangeRecord,
  classifier: "conventional" | "labels",
  types: readonly string[],
  labels: readonly string[],
): boolean {
  if (classifier === "conventional") {
    return record.type !== null && types.includes(record.type);
  }
  return record.labels.some((label) => labels.includes(label));
}

function classifyRecord(
  input: ChangeRecord,
  policy: EffectiveNotesPolicy,
  diagnostics: string[],
): ChangeRecord {
  const record: ChangeRecord = {
    ...input,
    labels: [...input.labels],
    commitShas: [...input.commitShas],
    breakingDescriptions: [...input.breakingDescriptions],
    provenance: [...input.provenance],
  };

  if (
    record.labels.some((label) =>
      policy.classify.breakingLabels.includes(label),
    )
  ) {
    record.breaking = true;
    record.provenance.push("breaking-label");
  }

  for (const classifier of policy.classify.by) {
    const matches = policy.classify.categories.filter((category) =>
      matchesCategory(
        record,
        classifier,
        category.types,
        category.labels,
      ),
    );
    if (matches.length === 0) continue;
    const selected = matches[0]!;
    record.category = selected.id;
    record.categoryTitle = selected.title;
    record.provenance.push(`category:${classifier}:${selected.id}`);
    if (matches.length > 1) {
      diagnostics.push(
        `${record.id}: multiple ${classifier} categories matched; selected ${selected.id}`,
      );
    }
    break;
  }

  if (!record.category) {
    if (policy.classify.unknown === "error") {
      throw new Error(
        `could not classify release-note record ${record.id}`,
      );
    }
    record.category = "other";
    record.categoryTitle = "Other Changes";
    record.provenance.push("category:fallback:other");
  }

  if (record.category === "security") record.security = true;
  if (record.category === "deprecations") record.deprecated = true;
  if (record.category === "removals") record.removed = true;

  return record;
}

function exclusionReasons(
  record: ChangeRecord,
  policy: EffectiveNotesPolicy,
): string[] {
  const reasons: string[] = [];
  const exclude = policy.filter.exclude;
  if (record.type && exclude.types.includes(record.type)) {
    reasons.push(`type:${record.type}`);
  }
  if (record.scope && exclude.scopes.includes(record.scope)) {
    reasons.push(`scope:${record.scope}`);
  }
  for (const label of record.labels) {
    if (exclude.labels.includes(label)) {
      reasons.push(`label:${label}`);
    }
  }
  if (record.author && exclude.authors.includes(record.author)) {
    reasons.push(`author:${record.author}`);
  }
  if (exclude.bots && record.isBot === true) {
    reasons.push("bot");
  }
  return reasons;
}

export function classifyChanges(
  inputs: readonly ChangeRecord[],
  policy: EffectiveNotesPolicy,
): ClassifiedChanges {
  const diagnostics: string[] = [];
  const included: ChangeRecord[] = [];
  const excluded: ClassifiedChanges["excluded"] = [];

  for (const input of [...inputs].sort(
    (a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id),
  )) {
    const record = classifyRecord(input, policy, diagnostics);
    const reasons = exclusionReasons(record, policy);
    if (reasons.length > 0) {
      excluded.push({ record, reasons });
      if (record.breaking) {
        diagnostics.push(
          `${record.id}: breaking change excluded by explicit filter (${reasons.join(", ")})`,
        );
      }
      continue;
    }
    included.push(record);
  }

  return { included, excluded, diagnostics };
}
