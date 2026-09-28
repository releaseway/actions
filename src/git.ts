import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface GitCommandResult {
  stdout: string;
  status: number;
}

export class GitRepository {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  run(args: readonly string[], allowFailure = false): GitCommandResult {
    const result = spawnSync("git", ["-C", this.path, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (result.error) {
      throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
    }
    const status = result.status ?? 1;
    if (!allowFailure && status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`,
      );
    }
    return {
      stdout: result.stdout ?? "",
      status,
    };
  }

  resolveCommit(ref: string): string {
    return this.run(["rev-parse", `${ref}^{commit}`]).stdout.trim().toLowerCase();
  }

  hasRef(ref: string): boolean {
    return this.run(["rev-parse", "--verify", "--quiet", ref], true).status === 0;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const result = this.run(
      ["merge-base", "--is-ancestor", ancestor, descendant],
      true,
    );
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error(
      `could not test ancestry between ${ancestor} and ${descendant}`,
    );
  }

  firstParentChain(target: string): string[] {
    return this.run(["rev-list", "--first-parent", target])
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
      .map((sha) => sha.toLowerCase());
  }

  tags(): string[] {
    return this.run(["tag", "--list"])
      .stdout.split("\n")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  remoteUrl(name = "origin"): string {
    return this.run(["remote", "get-url", name]).stdout.trim();
  }
}

export interface EvidenceRepository {
  repository: GitRepository;
  path: string;
  origin: string;
  targetTag: string;
  targetSha: string;
}

export async function createEvidenceRepository(options: {
  workspace: string;
  tempRoot: string;
  targetTag: string;
  expectedTargetSha: string;
}): Promise<EvidenceRepository> {
  const workspace = new GitRepository(resolve(options.workspace));
  const origin = workspace.remoteUrl();
  const path = await mkdtemp(join(resolve(options.tempRoot), "releaseway-notes-git-"));
  const repository = new GitRepository(path);

  repository.run(["init", "--bare"]);
  repository.run(["remote", "add", "origin", origin]);
  repository.run([
    "fetch",
    "--force",
    "--no-recurse-submodules",
    "origin",
    "+refs/tags/*:refs/tags/*",
  ]);

  const targetRef = `refs/tags/${options.targetTag}`;
  if (!repository.hasRef(targetRef)) {
    throw new Error(`release tag is missing from evidence origin: ${options.targetTag}`);
  }
  const targetSha = repository.resolveCommit(targetRef);
  const expected = options.expectedTargetSha.toLowerCase();
  if (targetSha !== expected) {
    throw new Error(
      `release tag target does not match commit in evidence repository: tag=${targetSha} expected=${expected}`,
    );
  }

  return {
    repository,
    path,
    origin,
    targetTag: options.targetTag,
    targetSha,
  };
}

export interface CommitEvidence {
  sha: string;
  parents: string[];
  message: string;
  authorName: string;
  ordinal: number;
}

function selectedCommitGraph(
  repository: GitRepository,
  targetSha: string,
  baseSha: string | null,
): Map<string, string[]> {
  const args = ["rev-list", "--parents", targetSha];
  if (baseSha) args.push(`^${baseSha}`);
  const rows = repository.run(args).stdout.trim().split("\n").filter(Boolean);
  const selected = new Set(rows.map((row) => row.split(/\s+/)[0]!.toLowerCase()));
  const graph = new Map<string, string[]>();
  for (const row of rows) {
    const [shaRaw, ...parentsRaw] = row.trim().split(/\s+/);
    const sha = shaRaw!.toLowerCase();
    graph.set(
      sha,
      parentsRaw
        .map((parent) => parent.toLowerCase())
        .filter((parent) => selected.has(parent)),
    );
  }
  return graph;
}

function deterministicTopoOrder(graph: Map<string, string[]>): string[] {
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const [sha, parents] of graph) {
    indegree.set(sha, parents.length);
    for (const parent of parents) {
      const list = children.get(parent) ?? [];
      list.push(sha);
      children.set(parent, list);
    }
  }

  const ready = [...graph.keys()]
    .filter((sha) => (indegree.get(sha) ?? 0) === 0)
    .sort();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const sha = ready.shift()!;
    ordered.push(sha);
    const nextChildren = (children.get(sha) ?? []).sort();
    for (const child of nextChildren) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        const index = ready.findIndex((candidate) => candidate > child);
        if (index === -1) ready.push(child);
        else ready.splice(index, 0, child);
      }
    }
  }

  if (ordered.length !== graph.size) {
    throw new Error("selected commit graph is not acyclic");
  }
  return ordered;
}

export function collectCommitEvidence(
  repository: GitRepository,
  targetSha: string,
  baseSha: string | null,
): CommitEvidence[] {
  const graph = selectedCommitGraph(repository, targetSha, baseSha);
  const ordered = deterministicTopoOrder(graph);
  return ordered.map((sha, ordinal) => {
    const message = repository.run(["show", "-s", "--format=%B", sha]).stdout;
    const authorName = repository.run(["show", "-s", "--format=%an", sha]).stdout.trim();
    const parents = repository.run(["show", "-s", "--format=%P", sha])
      .stdout.trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((parent) => parent.toLowerCase());
    return {
      sha,
      parents,
      message,
      authorName,
      ordinal,
    };
  });
}
