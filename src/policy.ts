import type {
  FirstReleasePolicy,
  RangeAncestry,
  RangePolicy,
  RangeStrategy,
} from "./range.ts";
import type { NotesMode } from "./contract.ts";

export type ChangeSource = "commits" | "pull-requests" | "hybrid";
export type Classifier = "conventional" | "labels";
export type UnknownPolicy = "other" | "error";
export type RenderLayout =
  | "standard"
  | "compact"
  | "conventional"
  | "changelog"
  | "detailed"
  | "scoped";

export interface CategoryRule {
  id: string;
  title: string;
  types: string[];
  labels: string[];
}

export interface FilterPolicy {
  exclude: {
    types: string[];
    scopes: string[];
    labels: string[];
    authors: string[];
    bots: boolean;
  };
}

export interface ClassificationPolicy {
  by: Classifier[];
  unknown: UnknownPolicy;
  categories: CategoryRule[];
  breakingLabels: string[];
}

export interface RenderPolicy {
  layout: RenderLayout;
  authors: boolean;
  comparison: boolean;
}

export interface EffectiveNotesPolicy {
  preset: NotesMode;
  source: ChangeSource;
  range: RangePolicy;
  classify: ClassificationPolicy;
  filter: FilterPolicy;
  render: RenderPolicy;
  unmatched: "error" | "omit";
}

export interface GitHubNotesConfig {
  previousTag?: string;
  configurationFile?: string;
}

const STANDARD_CATEGORIES: CategoryRule[] = [
  { id: "security", title: "Security", types: ["security"], labels: ["security"] },
  { id: "features", title: "Features", types: ["feat"], labels: ["feature", "enhancement"] },
  { id: "fixes", title: "Fixes", types: ["fix"], labels: ["bug", "fix"] },
  { id: "performance", title: "Performance", types: ["perf"], labels: ["performance"] },
  { id: "deprecations", title: "Deprecations", types: ["deprecated", "deprecate"], labels: ["deprecated"] },
  { id: "removals", title: "Removals", types: ["removed", "remove"], labels: ["removed"] },
  { id: "documentation", title: "Documentation", types: ["docs"], labels: ["documentation", "docs"] },
  { id: "dependencies", title: "Dependencies", types: ["deps", "dependencies"], labels: ["dependencies"] },
  {
    id: "maintenance",
    title: "Maintenance",
    types: ["build", "ci", "chore", "refactor", "style", "test"],
    labels: ["maintenance", "chore"],
  },
];

export const STANDARD_SECTION_ORDER = [
  "breaking",
  "security",
  "features",
  "fixes",
  "performance",
  "deprecations",
  "removals",
  "documentation",
  "dependencies",
  "maintenance",
  "other",
] as const;

function cloneCategories(): CategoryRule[] {
  return STANDARD_CATEGORIES.map((category) => ({
    ...category,
    types: [...category.types],
    labels: [...category.labels],
  }));
}

function basePolicy(preset: NotesMode, layout: RenderLayout): EffectiveNotesPolicy {
  return {
    preset,
    source: "commits",
    range: {
      strategy: "auto",
      ancestry: "first-parent",
      firstRelease: "all",
    },
    classify: {
      by: ["conventional"],
      unknown: "other",
      categories: cloneCategories(),
      breakingLabels: ["breaking", "breaking-change"],
    },
    filter: {
      exclude: {
        types: [],
        scopes: [],
        labels: [],
        authors: [],
        bots: false,
      },
    },
    render: {
      layout,
      authors: layout === "detailed",
      comparison: true,
    },
    unmatched: "error",
  };
}

export function presetPolicy(mode: NotesMode): EffectiveNotesPolicy | null {
  switch (mode) {
    case "standard":
      return basePolicy(mode, "standard");
    case "compact":
      return basePolicy(mode, "compact");
    case "conventional":
      return basePolicy(mode, "conventional");
    case "changelog":
      return basePolicy(mode, "changelog");
    case "detailed":
      return basePolicy(mode, "detailed");
    case "scoped":
      return basePolicy(mode, "scoped");
    case "pull-requests": {
      const policy = basePolicy(mode, "standard");
      policy.source = "pull-requests";
      policy.classify.by = ["labels", "conventional"];
      return policy;
    }
    case "hybrid": {
      const policy = basePolicy(mode, "standard");
      policy.source = "hybrid";
      policy.classify.by = ["labels", "conventional"];
      return policy;
    }
    case "github":
    case "file":
    case "none":
      return null;
  }
}

export function clonePolicy(policy: EffectiveNotesPolicy): EffectiveNotesPolicy {
  return {
    ...policy,
    range: {
      ...policy.range,
      from: policy.range.from ? { ...policy.range.from } : undefined,
    },
    classify: {
      ...policy.classify,
      by: [...policy.classify.by],
      categories: policy.classify.categories.map((category) => ({
        ...category,
        types: [...category.types],
        labels: [...category.labels],
      })),
      breakingLabels: [...policy.classify.breakingLabels],
    },
    filter: {
      exclude: {
        ...policy.filter.exclude,
        types: [...policy.filter.exclude.types],
        scopes: [...policy.filter.exclude.scopes],
        labels: [...policy.filter.exclude.labels],
        authors: [...policy.filter.exclude.authors],
      },
    },
    render: { ...policy.render },
  };
}

export function rangePolicyFromValues(values: {
  strategy?: RangeStrategy;
  ancestry?: RangeAncestry;
  firstRelease?: FirstReleasePolicy;
  tagPattern?: string;
  from?: { tag: string } | { commit: string };
}): Partial<RangePolicy> {
  return {
    ...(values.strategy ? { strategy: values.strategy } : {}),
    ...(values.ancestry ? { ancestry: values.ancestry } : {}),
    ...(values.firstRelease ? { firstRelease: values.firstRelease } : {}),
    ...(values.tagPattern ? { tagPattern: values.tagPattern } : {}),
    ...(values.from ? { from: values.from } : {}),
  };
}
