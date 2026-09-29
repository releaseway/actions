import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

import type { NotesMode } from "./contract.ts";
import {
  clonePolicy,
  type CategoryRule,
  type Classifier,
  type EffectiveNotesPolicy,
  type GitHubNotesConfig,
  type RenderLayout,
  type UnknownPolicy,
  presetPolicy,
} from "./policy.ts";
import type {
  FirstReleasePolicy,
  RangeAncestry,
  RangeStrategy,
} from "./range.ts";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_DEPTH = 16;

interface NotesConfigDocument {
  version: 1;
  notes: Record<string, unknown>;
}

export interface ResolvedConfig {
  policy: EffectiveNotesPolicy | null;
  github: GitHubNotesConfig | null;
  sourcePath: string | null;
}

function object(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${path} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${path}.${key} is not supported`);
    }
  }
}

function stringValue(
  value: unknown,
  path: string,
  options: { nonempty?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  if (options.nonempty && value.length === 0) {
    throw new Error(`${path} must not be empty`);
  }
  return value;
}

function fullCommitShaValue(value: unknown, path: string): string {
  const text = stringValue(value, path, { nonempty: true }).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(text)) {
    throw new Error(`${path} must be a full 40-character commit SHA`);
  }
  return text;
}

function repositoryPathValue(value: unknown, path: string): string {
  const text = stringValue(value, path, { nonempty: true });
  if (
    text.startsWith("/") ||
    text.includes("\\") ||
    text.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`${path} must be a relative repository path`);
  }
  return text;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: T,
): T[number] {
  const text = stringValue(value, path);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return text as T[number];
}

function stringArray(
  value: unknown,
  path: string,
  options: { normalizeLower?: boolean; unique?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  const items = value.map((item, index) => {
    const text = stringValue(item, `${path}[${index}]`, {
      nonempty: true,
    });
    return options.normalizeLower ? text.toLowerCase() : text;
  });
  if (options.unique !== false && new Set(items).size !== items.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
  return items;
}

function depth(value: unknown, current = 0): number {
  if (current > MAX_CONFIG_DEPTH) return current;
  if (Array.isArray(value)) {
    return value.reduce(
      (maximum, item) => Math.max(maximum, depth(item, current + 1)),
      current,
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce(
      (maximum, item) => Math.max(maximum, depth(item, current + 1)),
      current,
    );
  }
  return current;
}

export function parseConfigText(
  text: string,
  extension: string,
): NotesConfigDocument {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error(
      `notes-config exceeds ${MAX_CONFIG_BYTES} bytes`,
    );
  }

  let raw: unknown;
  if (extension === ".json") {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `notes-config JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (extension === ".yml" || extension === ".yaml") {
    const document = parseDocument(text, {
      uniqueKeys: true,
      schema: "core",
    });
    if (document.errors.length > 0) {
      throw new Error(
        `notes-config YAML is invalid: ${document.errors[0]!.message}`,
      );
    }
    try {
      raw = document.toJS({ maxAliasCount: 0 });
    } catch (error) {
      throw new Error(
        `notes-config YAML aliases are not supported: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    throw new Error("notes-config must use .yml, .yaml, or .json");
  }

  if (depth(raw) > MAX_CONFIG_DEPTH) {
    throw new Error(
      `notes-config exceeds maximum depth ${MAX_CONFIG_DEPTH}`,
    );
  }

  const root = object(raw, "config");
  assertKeys(root, ["version", "notes"], "config");
  if (root.version !== 1) {
    throw new Error("config.version must be 1");
  }
  const notes = object(root.notes, "config.notes");
  return {
    version: 1,
    notes,
  };
}

function withinRoot(path: string, root: string): boolean {
  const diff = relative(root, path);
  return (
    diff === "" ||
    (!diff.startsWith(".." + sep) && diff !== ".." && !isAbsolute(diff))
  );
}

export async function readConfigFile(options: {
  inputPath: string;
  workspace: string;
  runnerTemp?: string;
}): Promise<{ path: string; text: string }> {
  const workspace = await realpath(resolve(options.workspace));
  const runnerTemp = options.runnerTemp
    ? await realpath(resolve(options.runnerTemp))
    : null;
  const candidate = isAbsolute(options.inputPath)
    ? resolve(options.inputPath)
    : resolve(workspace, options.inputPath);
  const path = await realpath(candidate);

  if (
    !withinRoot(path, workspace) &&
    !(runnerTemp && withinRoot(path, runnerTemp))
  ) {
    throw new Error(
      "notes-config must resolve within GITHUB_WORKSPACE or RUNNER_TEMP",
    );
  }
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error("notes-config must be a regular file");
  }
  if (metadata.size > MAX_CONFIG_BYTES) {
    throw new Error(
      `notes-config exceeds ${MAX_CONFIG_BYTES} bytes`,
    );
  }
  return {
    path,
    text: await readFile(path, "utf8"),
  };
}

function parseCategory(
  value: unknown,
  index: number,
): CategoryRule {
  const path = `config.notes.classify.categories[${index}]`;
  const category = object(value, path);
  assertKeys(category, ["id", "title", "types", "labels"], path);
  const id = stringValue(category.id, path + ".id", {
    nonempty: true,
  });
  const title = stringValue(category.title, path + ".title", {
    nonempty: true,
  });
  if (id === "other") {
    throw new Error(
      path + ".id uses reserved fallback category id: other",
    );
  }
  return {
    id,
    title,
    types:
      category.types === undefined
        ? []
        : stringArray(category.types, path + ".types", {
            normalizeLower: true,
          }),
    labels:
      category.labels === undefined
        ? []
        : stringArray(category.labels, path + ".labels"),
  };
}

function applyRange(
  policy: EffectiveNotesPolicy,
  value: unknown,
): void {
  const path = "config.notes.range";
  const range = object(value, path);
  assertKeys(
    range,
    [
      "strategy",
      "from",
      "tag-pattern",
      "ancestry",
      "first-release",
    ],
    path,
  );

  if (range.strategy !== undefined && range.from !== undefined) {
    throw new Error(
      "config.notes.range.strategy and config.notes.range.from are mutually exclusive",
    );
  }
  if (range.strategy !== undefined) {
    policy.range.strategy = enumValue(
      range.strategy,
      path + ".strategy",
      [
        "auto",
        "previous-release",
        "previous-stable",
        "previous-tag",
      ] as const,
    ) as RangeStrategy;
    delete policy.range.from;
  }
  if (range.from !== undefined) {
    const from = object(range.from, path + ".from");
    assertKeys(from, ["tag", "commit"], path + ".from");
    if (
      (from.tag === undefined) ===
      (from.commit === undefined)
    ) {
      throw new Error(
        "config.notes.range.from must contain exactly one of tag or commit",
      );
    }
    policy.range.from =
      from.tag !== undefined
        ? {
            tag: stringValue(
              from.tag,
              path + ".from.tag",
              { nonempty: true },
            ),
          }
        : {
            commit: fullCommitShaValue(
              from.commit,
              path + ".from.commit",
            ),
          };
  }
  if (range["tag-pattern"] !== undefined) {
    policy.range.tagPattern = stringValue(
      range["tag-pattern"],
      path + ".tag-pattern",
      { nonempty: true },
    );
  }
  if (range.ancestry !== undefined) {
    policy.range.ancestry = enumValue(
      range.ancestry,
      path + ".ancestry",
      ["first-parent", "reachable"] as const,
    ) as RangeAncestry;
  }
  if (range["first-release"] !== undefined) {
    policy.range.firstRelease = enumValue(
      range["first-release"],
      path + ".first-release",
      ["all", "empty", "error"] as const,
    ) as FirstReleasePolicy;
  }
}

function applyClassify(
  policy: EffectiveNotesPolicy,
  value: unknown,
): void {
  const path = "config.notes.classify";
  const classify = object(value, path);
  assertKeys(
    classify,
    ["by", "unknown", "categories", "breaking-labels"],
    path,
  );

  if (classify.by !== undefined) {
    policy.classify.by = stringArray(
      classify.by,
      path + ".by",
      { normalizeLower: true },
    ).map((classifier) =>
      enumValue(
        classifier,
        path + ".by",
        ["conventional", "labels"] as const,
      ) as Classifier
    );
  }
  if (classify.unknown !== undefined) {
    policy.classify.unknown = enumValue(
      classify.unknown,
      path + ".unknown",
      ["other", "error"] as const,
    ) as UnknownPolicy;
  }
  if (classify.categories !== undefined) {
    if (!Array.isArray(classify.categories)) {
      throw new Error(path + ".categories must be an array");
    }
    const categories = classify.categories.map(parseCategory);
    const ids = categories.map((category) => category.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(
        path + ".categories must use unique ids",
      );
    }
    policy.classify.categories = categories;
  }
  if (classify["breaking-labels"] !== undefined) {
    policy.classify.breakingLabels = stringArray(
      classify["breaking-labels"],
      path + ".breaking-labels",
    );
  }
}

function applyFilter(
  policy: EffectiveNotesPolicy,
  value: unknown,
): void {
  const path = "config.notes.filter";
  const filter = object(value, path);
  assertKeys(filter, ["exclude"], path);
  if (filter.exclude === undefined) return;

  const excludePath = path + ".exclude";
  const exclude = object(filter.exclude, excludePath);
  assertKeys(
    exclude,
    ["types", "scopes", "labels", "authors", "bots"],
    excludePath,
  );
  if (exclude.types !== undefined) {
    policy.filter.exclude.types = stringArray(
      exclude.types,
      excludePath + ".types",
      { normalizeLower: true },
    );
  }
  if (exclude.scopes !== undefined) {
    policy.filter.exclude.scopes = stringArray(
      exclude.scopes,
      excludePath + ".scopes",
    );
  }
  if (exclude.labels !== undefined) {
    policy.filter.exclude.labels = stringArray(
      exclude.labels,
      excludePath + ".labels",
    );
  }
  if (exclude.authors !== undefined) {
    policy.filter.exclude.authors = stringArray(
      exclude.authors,
      excludePath + ".authors",
    );
  }
  if (exclude.bots !== undefined) {
    policy.filter.exclude.bots = booleanValue(
      exclude.bots,
      excludePath + ".bots",
    );
  }
}

function applyRender(
  policy: EffectiveNotesPolicy,
  value: unknown,
): void {
  const path = "config.notes.render";
  const render = object(value, path);
  assertKeys(render, ["layout", "authors", "comparison"], path);
  if (render.layout !== undefined) {
    policy.render.layout = enumValue(
      render.layout,
      path + ".layout",
      [
        "standard",
        "compact",
        "conventional",
        "changelog",
        "detailed",
        "scoped",
      ] as const,
    ) as RenderLayout;
  }
  if (render.authors !== undefined) {
    policy.render.authors = booleanValue(
      render.authors,
      path + ".authors",
    );
  }
  if (render.comparison !== undefined) {
    policy.render.comparison = booleanValue(
      render.comparison,
      path + ".comparison",
    );
  }
}

function resolveGitHubConfig(
  notes: Record<string, unknown>,
): GitHubNotesConfig {
  assertKeys(notes, ["github"], "config.notes");
  if (notes.github === undefined) return {};
  const github = object(notes.github, "config.notes.github");
  assertKeys(
    github,
    ["previous-tag", "configuration-file"],
    "config.notes.github",
  );
  return {
    ...(github["previous-tag"] !== undefined
      ? {
          previousTag: stringValue(
            github["previous-tag"],
            "config.notes.github.previous-tag",
            { nonempty: true },
          ),
        }
      : {}),
    ...(github["configuration-file"] !== undefined
      ? {
          configurationFile: repositoryPathValue(
            github["configuration-file"],
            "config.notes.github.configuration-file",
          ),
        }
      : {}),
  };
}

export function resolveConfig(
  mode: NotesMode,
  document: NotesConfigDocument | null,
): ResolvedConfig {
  if (mode === "file" || mode === "none") {
    if (document) {
      throw new Error(
        `notes-config is not supported when notes=${mode}`,
      );
    }
    return {
      policy: null,
      github: null,
      sourcePath: null,
    };
  }

  if (mode === "github") {
    return {
      policy: null,
      github: document
        ? resolveGitHubConfig(document.notes)
        : {},
      sourcePath: null,
    };
  }

  const preset = presetPolicy(mode);
  if (!preset) {
    throw new Error(`notes preset does not support custom policy: ${mode}`);
  }
  const policy = clonePolicy(preset);
  if (!document) {
    return { policy, github: null, sourcePath: null };
  }

  const notes = document.notes;
  assertKeys(
    notes,
    [
      "source",
      "range",
      "classify",
      "filter",
      "render",
      "unmatched",
    ],
    "config.notes",
  );
  if (notes.source !== undefined) {
    policy.source = enumValue(
      notes.source,
      "config.notes.source",
      ["commits", "pull-requests", "hybrid"] as const,
    );
  }
  if (notes.range !== undefined) applyRange(policy, notes.range);
  if (notes.classify !== undefined) {
    applyClassify(policy, notes.classify);
  }
  if (notes.filter !== undefined) applyFilter(policy, notes.filter);
  if (notes.render !== undefined) applyRender(policy, notes.render);
  if (notes.unmatched !== undefined) {
    policy.unmatched = enumValue(
      notes.unmatched,
      "config.notes.unmatched",
      ["error", "omit"] as const,
    );
  }

  if (
    policy.source === "commits" &&
    (policy.classify.by.includes("labels") ||
      policy.filter.exclude.labels.length > 0 ||
      policy.filter.exclude.bots)
  ) {
    throw new Error(
      "commit-only source cannot use label or bot classification/filtering",
    );
  }
  if (
    policy.source !== "pull-requests" &&
    policy.unmatched !== "error"
  ) {
    throw new Error(
      "unmatched is supported only for pull-requests source",
    );
  }

  return { policy, github: null, sourcePath: null };
}
