import type { ClassifiedChanges, ChangeRecord } from "./model.ts";
import {
  STANDARD_SECTION_ORDER,
  type EffectiveNotesPolicy,
} from "./policy.ts";

export interface RenderContext {
  repository: string;
  targetTag: string;
  targetSha: string;
  baseTag: string | null;
  baseSha: string | null;
  firstRelease: boolean;
  intentionallyEmpty?: boolean;
}

function repositoryUrl(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must be owner/name for Markdown links");
  }
  return `https://github.com/${repository}`;
}

export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, "\\$1");
}

function reference(
  record: ChangeRecord,
  context: RenderContext,
): string {
  const root = repositoryUrl(context.repository);
  if (record.pullRequest !== null) {
    return `[#${record.pullRequest}](${root}/pull/${record.pullRequest})`;
  }
  const sha = record.commitShas[0];
  if (!sha) return "";
  return `[${sha.slice(0, 7)}](${root}/commit/${sha})`;
}

function recordLine(
  record: ChangeRecord,
  context: RenderContext,
  policy: EffectiveNotesPolicy,
): string {
  const scope = record.scope
    ? `**${escapeMarkdown(record.scope)}:** `
    : "";
  const ref = reference(record, context);
  const author =
    policy.render.authors && record.author
      ? ` — ${escapeMarkdown(record.author)}`
      : "";
  return `- ${scope}${escapeMarkdown(record.title)}${ref ? ` (${ref})` : ""}${author}`;
}

function detailedLines(
  record: ChangeRecord,
  context: RenderContext,
  policy: EffectiveNotesPolicy,
): string[] {
  const lines = [recordLine(record, context, policy)];
  if (record.body) {
    for (const line of record.body.split("\n")) {
      if (line.trim() !== "") {
        lines.push(`  - ${escapeMarkdown(line)}`);
      }
    }
  }
  return lines;
}

function breakingSection(
  records: readonly ChangeRecord[],
  context: RenderContext,
  policy: EffectiveNotesPolicy,
): string[] {
  const breaking = records.filter((record) => record.breaking);
  if (breaking.length === 0) return [];
  const lines = ["## Breaking Changes", ""];
  for (const record of breaking) {
    lines.push(recordLine(record, context, policy));
    for (const description of record.breakingDescriptions) {
      for (const line of description.split("\n")) {
        if (line.trim() !== "") {
          lines.push(`  - ${escapeMarkdown(line)}`);
        }
      }
    }
  }
  return lines;
}

function appendSection(
  output: string[],
  title: string,
  records: readonly ChangeRecord[],
  context: RenderContext,
  policy: EffectiveNotesPolicy,
  detailed = false,
): void {
  if (records.length === 0) return;
  if (output.length > 0 && output.at(-1) !== "") output.push("");
  output.push(`## ${escapeMarkdown(title)}`, "");
  for (const record of records) {
    output.push(
      ...(detailed
        ? detailedLines(record, context, policy)
        : [recordLine(record, context, policy)]),
    );
  }
}

function standardLayout(
  records: readonly ChangeRecord[],
  context: RenderContext,
  policy: EffectiveNotesPolicy,
  detailed: boolean,
): string[] {
  const output = breakingSection(records, context, policy);
  const ordinary = records.filter((record) => !record.breaking);
  const categories = [
    ...policy.classify.categories.map((category) => ({
      id: category.id,
      title: category.title,
    })),
    { id: "other", title: "Other Changes" },
  ];
  for (const category of categories) {
    appendSection(
      output,
      category.title,
      ordinary.filter((record) => record.category === category.id),
      context,
      policy,
      detailed,
    );
  }
  return output;
}

function compactLayout(
  records: readonly ChangeRecord[],
  context: RenderContext,
  policy: EffectiveNotesPolicy,
): string[] {
  const output = breakingSection(records, context, policy);
  appendSection(
    output,
    "Changes",
    records.filter((record) => !record.breaking),
    context,
    policy,
  );
  return output;
}

function conventionalLayout(
  records: readonly ChangeRecord[],
  context: RenderContext,
  policy: EffectiveNotesPolicy,
): string[] {
  const output = breakingSection(records, context, policy);
  const ordinary = records.filter((record) => !record.breaking);
  const types = [
    ...new Set(ordinary.map((record) => record.type ?? "other")),
  ].sort();
  for (const type of types) {
    appendSection(
      output,
      type === "other" ? "Other Changes" : type,
      ordinary.filter((record) => (record.type ?? "other") === type),
      context,
      policy,
    );
  }
  return output;
}

function changelogHeading(record: ChangeRecord): string {
  switch (record.category) {
    case "features":
      return "Added";
    case "fixes":
      return "Fixed";
    case "deprecations":
      return "Deprecated";
    case "removals":
      return "Removed";
    case "security":
      return "Security";
    case "performance":
      return "Changed";
    default:
      return "Other Changes";
  }
}

function changelogLayout(
  records: readonly ChangeRecord[],
  context: RenderContext,
  policy: EffectiveNotesPolicy,
): string[] {
  const output = breakingSection(records, context, policy);
  const ordinary = records.filter((record) => !record.breaking);
  for (const title of [
    "Added",
    "Changed",
    "Deprecated",
    "Removed",
    "Fixed",
    "Security",
    "Other Changes",
  ]) {
    appendSection(
      output,
      title,
      ordinary.filter((record) => changelogHeading(record) === title),
      context,
      policy,
    );
  }
  return output;
}

function scopedLayout(
  records: readonly ChangeRecord[],
  context: RenderContext,
  policy: EffectiveNotesPolicy,
): string[] {
  const output = breakingSection(records, context, policy);
  const ordinary = records.filter((record) => !record.breaking);
  const scopes = [
    ...new Set(ordinary.map((record) => record.scope ?? "Unscoped")),
  ].sort();

  for (const scope of scopes) {
    const scoped = ordinary.filter(
      (record) => (record.scope ?? "Unscoped") === scope,
    );
    if (scoped.length === 0) continue;
    if (output.length > 0 && output.at(-1) !== "") output.push("");
    output.push(`## ${escapeMarkdown(scope)}`, "");

    const categoryIds = [
      ...policy.classify.categories.map((category) => category.id),
      "other",
    ];
    for (const id of categoryIds) {
      const matching = scoped.filter((record) => record.category === id);
      if (matching.length === 0) continue;
      const title =
        id === "other"
          ? "Other Changes"
          : policy.classify.categories.find(
              (category) => category.id === id,
            )?.title ?? id;
      output.push(`### ${escapeMarkdown(title)}`, "");
      for (const record of matching) {
        output.push(recordLine(record, context, policy));
      }
      output.push("");
    }
    while (output.at(-1) === "") output.pop();
  }
  return output;
}

function comparisonFooter(
  context: RenderContext,
): string | null {
  const root = repositoryUrl(context.repository);
  if (context.baseSha && context.baseTag) {
    return `**Full Changelog:** [${escapeMarkdown(context.baseTag)}...${escapeMarkdown(context.targetTag)}](${root}/compare/${context.baseSha}...${context.targetSha})`;
  }
  if (context.firstRelease) {
    return `**Release History:** [${escapeMarkdown(context.targetTag)}](${root}/commits/${context.targetSha})`;
  }
  return null;
}

export function renderReleaseNotes(
  changes: ClassifiedChanges,
  policy: EffectiveNotesPolicy,
  context: RenderContext,
): string {
  if (context.intentionallyEmpty) return "";
  const records = changes.included;
  let lines: string[];

  switch (policy.render.layout) {
    case "standard":
      lines = standardLayout(records, context, policy, false);
      break;
    case "compact":
      lines = compactLayout(records, context, policy);
      break;
    case "conventional":
      lines = conventionalLayout(records, context, policy);
      break;
    case "changelog":
      lines = changelogLayout(records, context, policy);
      break;
    case "detailed":
      lines = standardLayout(records, context, policy, true);
      break;
    case "scoped":
      lines = scopedLayout(records, context, policy);
      break;
  }

  if (records.length === 0) {
    lines = ["No matching changes were found."];
  }

  if (policy.render.comparison) {
    const footer = comparisonFooter(context);
    if (footer) {
      if (lines.length > 0) lines.push("");
      lines.push(footer);
    }
  }

  while (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

export function standardSectionOrder(): readonly string[] {
  return STANDARD_SECTION_ORDER;
}
