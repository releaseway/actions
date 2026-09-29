import { spawnSync } from "node:child_process";

export interface PullRequestAssociation {
  number: number;
  title: string;
  body: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string | null;
  userType: string | null;
  labels: string[];
  baseRepository: string;
}

export interface GeneratedNativeNotes {
  body: string;
  name: string;
}

export interface ReleaseSnapshot {
  id: number;
  tag: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  url: string;
}

export interface PublishedReleaseSnapshot {
  tag: string;
  draft: boolean;
  prerelease: boolean;
}

export interface GitHubApi {
  associatedPullRequests(
    repository: string,
    commitSha: string,
  ): Promise<PullRequestAssociation[]>;
  pullRequest(
    repository: string,
    number: number,
  ): Promise<PullRequestAssociation>;
  generateReleaseNotes(options: {
    repository: string;
    tag: string;
    targetSha: string;
    previousTag?: string;
    configurationFile?: string;
  }): Promise<GeneratedNativeNotes>;
  releaseByTag(
    repository: string,
    tag: string,
  ): Promise<ReleaseSnapshot | null>;
  publishedReleases(
    repository: string,
  ): Promise<PublishedReleaseSnapshot[]>;
  releaseBody(
    repository: string,
    releaseId: number,
  ): Promise<string>;
}

type RunGh = (args: readonly string[]) => string;

function defaultRunGh(args: readonly string[]): string {
  const result = spawnSync("gh", [...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `gh api failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return result.stdout;
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function associationNumber(value: unknown): number | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const number = (value as Record<string, unknown>).number;
  return typeof number === "number" ? number : null;
}

function parsePullRequestView(
  value: unknown,
  repository: string,
): PullRequestAssociation | null {
  const pr = object(value, "pull request");
  if (
    typeof pr.number !== "number" ||
    typeof pr.title !== "string"
  ) {
    return null;
  }

  const mergeCommit =
    typeof pr.mergeCommit === "object" && pr.mergeCommit !== null
      ? object(pr.mergeCommit, "pull request merge commit")
      : null;
  const mergedAt =
    typeof pr.mergedAt === "string" ? pr.mergedAt : null;
  const mergeCommitSha =
    mergeCommit && typeof mergeCommit.oid === "string"
      ? mergeCommit.oid.toLowerCase()
      : null;
  if ((mergedAt === null) !== (mergeCommitSha === null)) {
    return null;
  }

  const author =
    typeof pr.author === "object" && pr.author !== null
      ? object(pr.author, "pull request author")
      : null;
  const labels = Array.isArray(pr.labels)
    ? pr.labels.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const name = (item as Record<string, unknown>).name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  const rawBot = author?.is_bot ?? author?.isBot;
  const isBot =
    typeof rawBot === "boolean" ? rawBot : null;

  return {
    number: pr.number,
    title: pr.title,
    body: typeof pr.body === "string" ? pr.body : "",
    mergedAt,
    mergeCommitSha,
    userLogin: author ? stringOrNull(author.login) : null,
    userType: isBot === null ? null : isBot ? "Bot" : "User",
    labels,
    baseRepository: repository,
  };
}

export class GhCliApi implements GitHubApi {
  private readonly runGh: RunGh;

  constructor(runGh: RunGh = defaultRunGh) {
    this.runGh = runGh;
  }

  private paginatedArray(
    endpoint: (page: number) => string,
    context: string,
  ): unknown[] {
    const values: unknown[] = [];
    const pageSize = 100;
    const maxPages = 20;

    for (let page = 1; page <= maxPages; page += 1) {
      const raw = JSON.parse(
        this.runGh([
          "api",
          "-H",
          "Accept: application/vnd.github+json",
          "-H",
          "X-GitHub-Api-Version: 2026-03-10",
          endpoint(page),
        ]),
      ) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error(`${context} page must be an array`);
      }
      values.push(...raw);
      if (raw.length < pageSize) return values;
    }

    throw new Error(
      `${context} exceeded bounded pagination limit of ${maxPages} pages`,
    );
  }

  async associatedPullRequests(
    repository: string,
    commitSha: string,
  ): Promise<PullRequestAssociation[]> {
    const values = this.paginatedArray(
      (page) =>
        `repos/${repository}/commits/${commitSha}/pulls?per_page=100&page=${page}`,
      "commit-to-PR response",
    );
    const numbers = [
      ...new Set(
        values.flatMap((value) => {
          const number = associationNumber(value);
          return number === null ? [] : [number];
        }),
      ),
    ];
    return Promise.all(
      numbers.map((number) => this.pullRequest(repository, number)),
    );
  }

  async pullRequest(
    repository: string,
    number: number,
  ): Promise<PullRequestAssociation> {
    const raw = JSON.parse(
      this.runGh([
        "pr",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "number,title,body,mergedAt,mergeCommit,author,labels",
      ]),
    ) as unknown;
    const parsed = parsePullRequestView(raw, repository);
    if (!parsed) {
      throw new Error(
        `pull request #${number} detail is missing merged landing metadata`,
      );
    }
    return parsed;
  }

  async generateReleaseNotes(options: {
    repository: string;
    tag: string;
    targetSha: string;
    previousTag?: string;
    configurationFile?: string;
  }): Promise<GeneratedNativeNotes> {
    const args = [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      "-X",
      "POST",
      `repos/${options.repository}/releases/generate-notes`,
      "-f",
      `tag_name=${options.tag}`,
      "-f",
      `target_commitish=${options.targetSha}`,
    ];
    if (options.previousTag) {
      args.push("-f", `previous_tag_name=${options.previousTag}`);
    }
    if (options.configurationFile) {
      args.push("-f", `configuration_file_path=${options.configurationFile}`);
    }

    const raw = object(
      JSON.parse(this.runGh(args)),
      "generated release notes response",
    );
    if (typeof raw.body !== "string" || typeof raw.name !== "string") {
      throw new Error("generated release notes response is missing name/body");
    }
    return { body: raw.body, name: raw.name };
  }

  async releaseByTag(
    repository: string,
    tag: string,
  ): Promise<ReleaseSnapshot | null> {
    let output: string;
    try {
      output = this.runGh([
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
        `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/404|not found/i.test(message)) return null;
      throw error;
    }
    const raw = object(JSON.parse(output), "release response");
    if (
      typeof raw.id !== "number" ||
      typeof raw.tag_name !== "string" ||
      typeof raw.draft !== "boolean" ||
      typeof raw.prerelease !== "boolean"
    ) {
      throw new Error("release response is missing required fields");
    }
    return {
      id: raw.id,
      tag: raw.tag_name,
      name: typeof raw.name === "string" ? raw.name : "",
      body: typeof raw.body === "string" ? raw.body : "",
      draft: raw.draft,
      prerelease: raw.prerelease,
      immutable: raw.immutable === true,
      url: typeof raw.html_url === "string" ? raw.html_url : "",
    };
  }

  async publishedReleases(
    repository: string,
  ): Promise<PublishedReleaseSnapshot[]> {
    const values = this.paginatedArray(
      (page) =>
        `repos/${repository}/releases?per_page=100&page=${page}`,
      "release-list response",
    );
    return values.map((item) => {
      const release = object(item, "release-list item");
      if (
        typeof release.tag_name !== "string" ||
        typeof release.draft !== "boolean" ||
        typeof release.prerelease !== "boolean"
      ) {
        throw new Error("release-list item is missing required fields");
      }
      return {
        tag: release.tag_name,
        draft: release.draft,
        prerelease: release.prerelease,
      };
    });
  }

  async releaseBody(
    repository: string,
    releaseId: number,
  ): Promise<string> {
    const raw = object(
      JSON.parse(
        this.runGh([
          "api",
          "-H",
          "Accept: application/vnd.github+json",
          "-H",
          "X-GitHub-Api-Version: 2026-03-10",
          `repos/${repository}/releases/${releaseId}`,
        ]),
      ),
      "release response",
    );
    return typeof raw.body === "string" ? raw.body : "";
  }
}
