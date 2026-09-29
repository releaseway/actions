import semver, { type SemVer } from "semver";

import { GitRepository } from "./git.ts";

export type RangeStrategy =
  | "auto"
  | "previous-release"
  | "previous-stable"
  | "previous-tag";
export type RangeAncestry = "first-parent" | "reachable";
export type FirstReleasePolicy = "all" | "empty" | "error";

export interface PublishedRelease {
  tag: string;
  draft?: boolean;
  prerelease: boolean;
}

export interface RangePolicy {
  strategy: RangeStrategy;
  ancestry: RangeAncestry;
  firstRelease: FirstReleasePolicy;
  tagPattern?: string;
  from?: { tag: string } | { commit: string };
}

export interface RangeResolution {
  targetTag: string;
  targetSha: string;
  baseTag: string | null;
  baseSha: string | null;
  firstRelease: boolean;
  empty: boolean;
  strategy: RangeStrategy | "explicit";
  ancestry: RangeAncestry;
  reason: string;
}

interface ParsedTag {
  tag: string;
  prefix: string;
  version: SemVer;
}

interface Candidate {
  tag: string;
  sha: string;
  version: SemVer | null;
  prerelease: boolean;
  priority: number;
}

const SEMVER_SUFFIX =
  /(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const DEFAULT_RANGE_POLICY: RangePolicy = {
  strategy: "auto",
  ancestry: "first-parent",
  firstRelease: "all",
};

export function parseVersionedTag(tag: string): ParsedTag | null {
  const match = tag.match(SEMVER_SUFFIX);
  if (!match || match.index === undefined) return null;
  const raw = match[0];
  const parsed = semver.parse(raw, { loose: false });
  if (!parsed) return null;
  return {
    tag,
    prefix: tag.slice(0, match.index),
    version: parsed,
  };
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern.length > 256) throw new Error("tag-pattern is too long");
  let expression = "^";
  for (const char of pattern) {
    if (char === "*") expression += ".*";
    else if (char === "?") expression += ".";
    else if ("\\.^$+{}()|[]".includes(char)) expression += "\\" + char;
    else expression += char;
  }
  expression += "$";
  return new RegExp(expression, "u").test(value);
}

function firstPrereleaseIdentifier(version: SemVer): string | number | null {
  return version.prerelease.length > 0 ? version.prerelease[0]! : null;
}

function sameCore(a: SemVer, b: SemVer): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

function stable(version: SemVer): boolean {
  return version.prerelease.length === 0;
}

function candidateAliases(candidates: Candidate[]): Candidate[] {
  const bySha = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = bySha.get(candidate.sha) ?? [];
    group.push(candidate);
    bySha.set(candidate.sha, group);
  }

  return [...bySha.values()].map((group) => {
    group.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.version && b.version) {
        const compare = semver.rcompare(a.version, b.version);
        if (compare !== 0) return compare;
      } else if (a.version && !b.version) return -1;
      else if (!a.version && b.version) return 1;
      return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
    });
    return group[0]!;
  });
}

function selectByAncestry(
  repository: GitRepository,
  targetSha: string,
  candidates: Candidate[],
  ancestry: RangeAncestry,
): Candidate | null {
  const aliases = candidateAliases(candidates);
  if (ancestry === "first-parent") {
    const chain = repository.firstParentChain(targetSha);
    const distance = new Map(chain.map((sha, index) => [sha, index]));
    const onChain = aliases.filter((candidate) => distance.has(candidate.sha));
    if (onChain.length > 0) {
      const priority = Math.min(...onChain.map((candidate) => candidate.priority));
      return onChain
        .filter((candidate) => candidate.priority === priority)
        .sort((a, b) => {
          const delta = distance.get(a.sha)! - distance.get(b.sha)!;
          if (delta !== 0) return delta;
          return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
        })[0]!;
    }
    if (aliases.length > 0) {
      throw new Error(
        "eligible prior releases exist but none is on the target first-parent ancestry; choose reachable ancestry or an explicit base",
      );
    }
    return null;
  }

  const reachable = aliases.filter((candidate) =>
    repository.isAncestor(candidate.sha, targetSha),
  );
  if (reachable.length === 0) return null;
  const priority = Math.min(...reachable.map((candidate) => candidate.priority));
  const preferred = reachable.filter(
    (candidate) => candidate.priority === priority,
  );

  const maximal = preferred.filter(
    (candidate) =>
      !preferred.some(
        (other) =>
          other.sha !== candidate.sha &&
          repository.isAncestor(candidate.sha, other.sha),
      ),
  );
  const uniqueShas = new Set(maximal.map((candidate) => candidate.sha));
  if (uniqueShas.size !== 1) {
    throw new Error(
      "reachable range candidates are ambiguous; choose an explicit base",
    );
  }
  return maximal.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))[0]!;
}

function releaseCandidates(
  repository: GitRepository,
  target: ParsedTag,
  releases: readonly PublishedRelease[],
  strategy: Exclude<RangeStrategy, "previous-tag">,
  tagPattern?: string,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const release of releases) {
    if (release.draft) continue;
    const parsed = parseVersionedTag(release.tag);
    if (!parsed) continue;
    if (tagPattern) {
      if (!wildcardMatch(tagPattern, target.tag)) {
        throw new Error("tag-pattern must match the target tag");
      }
      if (!wildcardMatch(tagPattern, release.tag)) continue;
    } else if (parsed.prefix !== target.prefix) {
      continue;
    }
    if (!semver.lt(parsed.version, target.version)) continue;
    if (
      strategy === "auto" &&
      (!stable(parsed.version)) !== release.prerelease
    ) {
      throw new Error(
        `published release ${release.tag} has prerelease state inconsistent with its SemVer tag; choose an explicit range policy/base or correct the release metadata`,
      );
    }

    let eligible = false;
    if (strategy === "previous-release") {
      eligible = true;
    } else if (strategy === "previous-stable") {
      eligible = stable(parsed.version) && !release.prerelease;
    } else if (stable(target.version)) {
      eligible = stable(parsed.version) && !release.prerelease;
    } else {
      const samePrereleaseLine =
        sameCore(parsed.version, target.version) &&
        firstPrereleaseIdentifier(parsed.version) ===
          firstPrereleaseIdentifier(target.version) &&
        release.prerelease;
      const priorStable = stable(parsed.version) && !release.prerelease;
      eligible = samePrereleaseLine || priorStable;
    }
    if (!eligible) continue;

    const ref = `refs/tags/${release.tag}`;
    if (!repository.hasRef(ref)) {
      throw new Error(
        `published release tag is missing from Git evidence: ${release.tag}`,
      );
    }
    candidates.push({
      tag: release.tag,
      sha: repository.resolveCommit(ref),
      version: parsed.version,
      prerelease: release.prerelease,
      priority:
        strategy === "auto" &&
        !stable(target.version) &&
        release.prerelease &&
        sameCore(parsed.version, target.version) &&
        firstPrereleaseIdentifier(parsed.version) ===
          firstPrereleaseIdentifier(target.version)
          ? 0
          : strategy === "auto" && !stable(target.version)
            ? 1
            : 0,
    });
  }
  return candidates;
}

function nonSemverReleaseCandidates(
  repository: GitRepository,
  targetTag: string,
  targetPrerelease: boolean,
  releases: readonly PublishedRelease[],
  strategy: Exclude<RangeStrategy, "previous-tag">,
  tagPattern: string,
): Candidate[] {
  if (!wildcardMatch(tagPattern, targetTag)) {
    throw new Error("tag-pattern must match the target tag");
  }

  const candidates: Candidate[] = [];
  for (const release of releases) {
    if (release.draft || release.tag === targetTag) continue;
    if (!wildcardMatch(tagPattern, release.tag)) continue;

    let eligible = false;
    let priority = 0;
    if (strategy === "previous-release") {
      eligible = true;
    } else if (strategy === "previous-stable") {
      eligible = !release.prerelease;
    } else if (targetPrerelease) {
      eligible = true;
      priority = release.prerelease ? 0 : 1;
    } else {
      eligible = !release.prerelease;
    }
    if (!eligible) continue;

    const ref = `refs/tags/${release.tag}`;
    if (!repository.hasRef(ref)) {
      throw new Error(
        `published release tag is missing from Git evidence: ${release.tag}`,
      );
    }
    candidates.push({
      tag: release.tag,
      sha: repository.resolveCommit(ref),
      version: null,
      prerelease: release.prerelease,
      priority,
    });
  }
  return candidates;
}

function tagCandidates(
  repository: GitRepository,
  targetTag: string,
  target: ParsedTag | null,
  tagPattern?: string,
): Candidate[] {
  if (!target && !tagPattern) {
    throw new Error(
      "automatic previous-tag selection for a non-SemVer tag requires tag-pattern",
    );
  }
  if (tagPattern && !wildcardMatch(tagPattern, targetTag)) {
    throw new Error("tag-pattern must match the target tag");
  }

  const candidates: Candidate[] = [];
  for (const tag of repository.tags()) {
    if (tag === targetTag) continue;
    if (tagPattern && !wildcardMatch(tagPattern, tag)) continue;
    const parsed = parseVersionedTag(tag);
    if (target && !tagPattern) {
      if (!parsed || parsed.prefix !== target.prefix) continue;
      if (!semver.lt(parsed.version, target.version)) continue;
    } else if (target && parsed && !semver.lt(parsed.version, target.version)) {
      continue;
    }
    candidates.push({
      tag,
      sha: repository.resolveCommit(`refs/tags/${tag}`),
      version: parsed?.version ?? null,
      prerelease: parsed ? !stable(parsed.version) : false,
      priority: 0,
    });
  }
  return candidates;
}

function firstReleaseResolution(
  targetTag: string,
  targetSha: string,
  policy: RangePolicy,
): RangeResolution {
  if (policy.firstRelease === "error") {
    throw new Error(
      "no eligible base release was found; an explicit base is required",
    );
  }
  return {
    targetTag,
    targetSha,
    baseTag: null,
    baseSha: null,
    firstRelease: true,
    empty: policy.firstRelease === "empty",
    strategy: policy.strategy,
    ancestry: policy.ancestry,
    reason:
      policy.firstRelease === "empty"
        ? "no eligible base; first-release policy requests empty notes"
        : "no eligible base; first-release policy includes all reachable history",
  };
}

export function resolveRange(options: {
  repository: GitRepository;
  targetTag: string;
  targetSha: string;
  releases: readonly PublishedRelease[];
  targetPrerelease?: boolean;
  policy?: Partial<RangePolicy>;
}): RangeResolution {
  const policy: RangePolicy = {
    ...DEFAULT_RANGE_POLICY,
    ...options.policy,
  };
  const targetSha = options.targetSha.toLowerCase();

  if (policy.from) {
    let baseTag: string | null;
    let baseSha: string;
    if ("tag" in policy.from) {
      baseTag = policy.from.tag;
      baseSha = options.repository.resolveCommit(`refs/tags/${baseTag}`);
    } else {
      baseTag = null;
      baseSha = options.repository.resolveCommit(policy.from.commit);
    }
    if (!options.repository.isAncestor(baseSha, targetSha)) {
      throw new Error("explicit range base is not an ancestor of the target");
    }
    return {
      targetTag: options.targetTag,
      targetSha,
      baseTag,
      baseSha,
      firstRelease: false,
      empty: baseSha === targetSha,
      strategy: "explicit",
      ancestry: policy.ancestry,
      reason: "explicit base selected",
    };
  }

  const parsedTarget = parseVersionedTag(options.targetTag);
  if (
    parsedTarget &&
    policy.strategy === "auto" &&
    options.targetPrerelease !== undefined
  ) {
    const tagPrerelease = !stable(parsedTarget.version);
    if (tagPrerelease !== options.targetPrerelease) {
      throw new Error(
        "target tag prerelease classification conflicts with requested prerelease state; choose an explicit range policy/base or make the release state match the tag",
      );
    }
  }
  if (!parsedTarget && policy.strategy !== "previous-tag" && !policy.tagPattern) {
    throw new Error(
      "automatic release selection for a non-SemVer tag requires tag-pattern or an explicit base",
    );
  }

  let candidates: Candidate[];
  if (policy.strategy === "previous-tag") {
    candidates = tagCandidates(
      options.repository,
      options.targetTag,
      parsedTarget,
      policy.tagPattern,
    );
  } else if (parsedTarget) {
    candidates = releaseCandidates(
      options.repository,
      parsedTarget,
      options.releases,
      policy.strategy,
      policy.tagPattern,
    );
  } else {
    if (!policy.tagPattern) {
      throw new Error(
        "published-release selection for a non-SemVer tag requires tag-pattern",
      );
    }
    candidates = nonSemverReleaseCandidates(
      options.repository,
      options.targetTag,
      options.targetPrerelease ?? false,
      options.releases,
      policy.strategy,
      policy.tagPattern,
    );
  }

  const selected = selectByAncestry(
    options.repository,
    targetSha,
    candidates,
    policy.ancestry,
  );
  if (!selected) {
    return firstReleaseResolution(options.targetTag, targetSha, policy);
  }

  return {
    targetTag: options.targetTag,
    targetSha,
    baseTag: selected.tag,
    baseSha: selected.sha,
    firstRelease: false,
    empty: selected.sha === targetSha,
    strategy: policy.strategy,
    ancestry: policy.ancestry,
    reason: `selected ${policy.strategy} base ${selected.tag}`,
  };
}
