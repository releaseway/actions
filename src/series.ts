import { compare, inc, prerelease, valid } from "semver";
import type { ReleaseConfig } from "./release-config.ts";
import { parseConventionalCommit } from "./conventional.ts";

export interface SeriesTag { tag: string; commit: string }

// Membership follows history after the explicit boundary, not the old numerical maximum.
export function seriesTags(config: ReleaseConfig, tags: readonly SeriesTag[], source: string, ancestor: (a: string, b: string) => boolean): SeriesTag[] {
  const base = config.series ? tags.find((tag) => tag.tag === config.series!.baseTag) : undefined;
  if (config.series && !base) throw new Error(`Series base tag does not exist on origin: ${config.series.baseTag}`);
  if (base && !ancestor(base.commit, source)) throw new Error("Series base tag must be an ancestor of the release source");
  return tags.filter((tag) => {
    const version = tag.tag.slice(config.tagPrefix.length);
    return tag.tag.startsWith(config.tagPrefix) && valid(version) === version && !version.includes("+") &&
      ancestor(tag.commit, source) && (!base || (tag.commit !== base.commit && !ancestor(tag.commit, base.commit)));
  });
}

export function nextSeriesVersion(config: ReleaseConfig, tags: readonly SeriesTag[], messages: readonly string[], prereleaseId = ""): string {
  if (prereleaseId && !/^[A-Za-z][A-Za-z0-9-]*$/.test(prereleaseId)) throw new Error("prerelease-id must be a single nonnumeric SemVer identifier");
  const versions = tags.map((tag) => tag.tag.slice(config.tagPrefix.length)).sort(compare);
  const previous = versions.at(-1);
  let next: string;
  if (!previous) {
    next = config.series?.startVersion ?? config.initialVersion;
  } else if (prerelease(previous) !== null) {
    const core = previous.split("-")[0]!;
    const id = prerelease(previous)![0];
    next = prereleaseId ? (id === prereleaseId ? inc(previous, "prerelease", prereleaseId)! : `${core}-${prereleaseId}.0`) : core;
    if (prereleaseId) {
      if (compare(next, previous) <= 0) throw new Error("Prerelease channel change would decrease the current series version");
      return next;
    }
  } else {
    let bump = config.bump;
    if (bump === "auto") {
      const changes = messages.map(parseConventionalCommit);
      bump = changes.some((change) => change.breaking) ? "major" : changes.some((change) => change.type === "feat") ? "minor" : "patch";
    }
    next = inc(previous, bump)!;
  }
  return prereleaseId ? `${next}-${prereleaseId}.0` : next;
}
