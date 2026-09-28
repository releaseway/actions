import { spawnSync } from "node:child_process";

export interface PullRequestAssociation {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  mergeCommitSha: string;
  userLogin: string | null;
  userType: string | null;
  labels: string[];
  baseRepository: string;
}

export interface GeneratedNativeNotes {
  body: string;
  name: string;
}

export interface GitHubApi {
  associatedPullRequests(
    repository: string,
    commitSha: string,
  ): Promise<PullRequestAssociation[]>;
  generateReleaseNotes(options: {
    repository: string;
    tag: string;
    targetSha: string;
    previousTag?: string;
    configurationFile?: string;
  }): Promise<GeneratedNativeNotes>;
}

type RunGh = (args: readonly string[]) => string;

function defaultRunGh(args: readonly string[]): string {
  const result = spawnSync("gh", [...args], {
    encoding: "utf8",
    env: process.env,
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

function parseAssociation(
  value: unknown,
  repository: string,
): PullRequestAssociation | null {
  const pr = object(value, "pull request association");
  if (
    typeof pr.number !== "number" ||
    typeof pr.title !== "string" ||
    typeof pr.merged_at !== "string" ||
    typeof pr.merge_commit_sha !== "string"
  ) {
    return null;
  }
  const base = object(pr.base, "pull request base");
  const baseRepo = object(base.repo, "pull request base repository");
  if (baseRepo.full_name !== repository) return null;

  const user =
    typeof pr.user === "object" && pr.user !== null
      ? object(pr.user, "pull request user")
      : null;
  const labels = Array.isArray(pr.labels)
    ? pr.labels.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const name = (item as Record<string, unknown>).name;
        return typeof name === "string" ? [name] : [];
      })
    : [];

  return {
    number: pr.number,
    title: pr.title,
    body: typeof pr.body === "string" ? pr.body : "",
    mergedAt: pr.merged_at,
    mergeCommitSha: pr.merge_commit_sha.toLowerCase(),
    userLogin: user ? stringOrNull(user.login) : null,
    userType: user ? stringOrNull(user.type) : null,
    labels,
    baseRepository: repository,
  };
}

export class GhCliApi implements GitHubApi {
  private readonly runGh: RunGh;

  constructor(runGh: RunGh = defaultRunGh) {
    this.runGh = runGh;
  }

  async associatedPullRequests(
    repository: string,
    commitSha: string,
  ): Promise<PullRequestAssociation[]> {
    const output = this.runGh([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      "--paginate",
      "--slurp",
      `repos/${repository}/commits/${commitSha}/pulls?per_page=100`,
    ]);
    const pages = JSON.parse(output) as unknown;
    if (!Array.isArray(pages)) {
      throw new Error("commit-to-PR response must be a page array");
    }
    const values = pages.flatMap((page) => {
      if (!Array.isArray(page)) {
        throw new Error("commit-to-PR page must be an array");
      }
      return page;
    });
    return values.flatMap((value) => {
      const parsed = parseAssociation(value, repository);
      return parsed ? [parsed] : [];
    });
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
}
