import { ReleaseError } from "./release-error.ts";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface GitCommandResult {
  stdout: string;
  status: number;
  stderr?: string;
}

export const MAX_RELEASE_COMMITS = 10_000;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_COMMIT_PARENTS = 4096;
const MAX_GRAPH_EDGES = 1_000_000;

interface GitRunOptions {
  allowFailure?: boolean;
  config?: readonly { key: string; value: string }[];
}

export class GitRepository {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): GitCommandResult {
    const {
      allowFailure = false,
      config = [],
    } = options;
    const configEnv: NodeJS.ProcessEnv = {};
    if (config.length > 0) {
      configEnv.GIT_CONFIG_COUNT = String(config.length);
      config.forEach(({ key, value }, index) => {
        configEnv[`GIT_CONFIG_KEY_${index}`] = key;
        configEnv[`GIT_CONFIG_VALUE_${index}`] = value;
      });
    }
    const result = spawnSync("git", ["-C", this.path, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: MAX_GIT_OUTPUT,
      env: { ...process.env, ...configEnv },
    });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOBUFS") {
        throw new Error(`git output exceeds ${MAX_GIT_OUTPUT} byte limit for a bounded evidence batch`);
      }
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
      stderr: result.stderr ?? "",
      status,
    };
  }

  resolveCommit(ref: string): string {
    return this.run(["rev-parse", `${ref}^{commit}`]).stdout.trim().toLowerCase();
  }

  hasRef(ref: string): boolean {
    return this.run(
      ["rev-parse", "--verify", "--quiet", ref],
      { allowFailure: true },
    ).status === 0;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const result = this.run(
      ["merge-base", "--is-ancestor", ancestor, descendant],
      { allowFailure: true },
    );
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error(
      `could not test ancestry between ${ancestor} and ${descendant}`,
    );
  }

  *firstParentChain(target: string): IterableIterator<string> {
    let cursor: string | undefined = target;
    while (cursor) {
      const rows: string[] = this.run(["rev-list", "--first-parent", "--parents", "--max-count=1024", cursor])
        .stdout.trim().split("\n").filter(Boolean);
      if (!rows.length) return;
      for (const row of rows) yield row.split(" ")[0]!.toLowerCase();
      cursor = rows.at(-1)!.split(" ")[1];
    }
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

  localHttpAuthConfig(): Array<{ key: string; value: string }> {
    const result = this.run(
      [
        "config",
        "--local",
        "--includes",
        "--get-regexp",
        "^http\\..*\\.extraheader$",
      ],
      { allowFailure: true },
    );
    if (result.status === 1) return [];
    if (result.status !== 0) {
      throw new Error("could not read checkout authentication configuration");
    }
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.search(/\s/);
        if (separator <= 0) {
          throw new Error("checkout authentication configuration is malformed");
        }
        return {
          key: line.slice(0, separator),
          value: line.slice(separator + 1),
        };
      });
  }

  remoteTagTarget(tag: string): string {
    let result: GitCommandResult;
    try {
      result = this.run(["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
    } catch {
      throw new ReleaseError("REMOTE_UNAVAILABLE", "Remote release tag binding could not be read");
    }
    let object = "";
    let target = "";
    for (const line of result.stdout.split("\n")) {
      const [sha, ref] = line.trim().split(/\s+/, 2);
      if (!sha || !ref) continue;
      if (ref === `refs/tags/${tag}`) object = sha.toLowerCase();
      if (ref === `refs/tags/${tag}^{}`) target = sha.toLowerCase();
    }
    if (!object) {
      throw new ReleaseError("TAG_NOT_FOUND", `release tag is missing from origin: ${tag}`);
    }
    return target || object;
  }
}

export function verifyRemoteTagBinding(options: {
  workspace: string;
  tag: string;
  expectedCommit: string;
}): string {
  const expected = options.expectedCommit.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    throw new ReleaseError("INVALID_INPUT", "commit must be a full 40-character SHA");
  }
  const repository = new GitRepository(resolve(options.workspace));
  const validRef = repository.run(
    ["check-ref-format", `refs/tags/${options.tag}`],
    { allowFailure: true },
  );
  if (validRef.status !== 0) {
    throw new ReleaseError("TAG_INVALID", `tag is not a valid Git tag: ${options.tag}`);
  }
  const target = repository.remoteTagTarget(options.tag);
  if (target !== expected) {
    throw new ReleaseError("TAG_COMMIT_MISMATCH",
      `release tag target does not match commit: tag=${target} expected=${expected}`, "present",
    );
  }
  return target;
}

export function verifyRemoteTagExists(options: {
  workspace: string;
  tag: string;
}): string {
  const repository = new GitRepository(resolve(options.workspace));
  const validRef = repository.run(
    ["check-ref-format", `refs/tags/${options.tag}`],
    { allowFailure: true },
  );
  if (validRef.status !== 0) {
    throw new ReleaseError("TAG_INVALID", `tag is not a valid Git tag: ${options.tag}`);
  }
  return repository.remoteTagTarget(options.tag);
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
  try {
    repository.run(["init", "--bare"]);
    repository.run(["remote", "add", "origin", origin]);
    repository.run(
      [
        "fetch",
        "--force",
        "--no-recurse-submodules",
        "origin",
        "+refs/tags/*:refs/tags/*",
      ],
      {
        config: workspace.localHttpAuthConfig(),
      },
    );

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
  } catch (error) {
    try { await rm(path, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Evidence preparation and cleanup failed"); }
    throw error;
  }
}

export async function withEvidenceRepository<T>(
  options: Parameters<typeof createEvidenceRepository>[0],
  consume: (evidence: EvidenceRepository) => Promise<T>,
): Promise<T> {
  const evidence = await createEvidenceRepository(options);
  let failure: unknown;
  try { return await consume(evidence); }
  catch (error) { failure = error; throw error; }
  finally {
    try { await rm(evidence.path, { recursive: true, force: true }); }
    catch (cleanupError) {
      if (failure !== undefined) throw new AggregateError([failure, cleanupError], "Notes preparation and evidence cleanup failed");
      throw cleanupError;
    }
  }
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
): { graph: Map<string, string[]>; details: Map<string, CommitEvidence> } {
  const range = [targetSha];
  if (baseSha) range.push(`^${baseSha}`);
  const countText = repository.run([
    "rev-list",
    "--count",
    ...range,
  ]).stdout.trim();
  const count = Number.parseInt(countText, 10);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("could not determine release commit count");
  }
  if (count > MAX_RELEASE_COMMITS) {
    throw new Error(
      `release history exceeds maximum commit count ${MAX_RELEASE_COMMITS}: ${count}`,
    );
  }

  const shas = repository.run(["rev-list", `--max-count=${MAX_RELEASE_COMMITS + 1}`, ...range])
    .stdout.trim().split("\n").filter(Boolean);
  if (shas.length > MAX_RELEASE_COMMITS) throw new Error("release history exceeds maximum commit count");
  const selected = new Set(shas);
  const graph = new Map<string, string[]>();
  const details = new Map<string, CommitEvidence>();
  let edges = 0;
  // Bound both argv and stdout; reuse the same metadata for notes after ordering.
  for (let offset = 0; offset < shas.length; offset += 16) {
    const batch = shas.slice(offset, offset + 16);
    const fields = repository.run(["log", "--no-walk=unsorted", "--format=%H%x00%P%x00%an%x00%B%x00", ...batch]).stdout.split("\0");
    if (fields.pop()?.trim() || fields.length !== batch.length * 4) throw new Error("Malformed Git commit evidence");
    for (let i = 0; i < fields.length; i += 4) {
      const sha = fields[i]!.trim().toLowerCase();
      if (!batch.includes(sha) || details.has(sha)) throw new Error("Unexpected Git commit evidence identity");
      const parents = fields[i + 1]!.trim().split(/\s+/).filter(Boolean).map(p => p.toLowerCase());
      edges += parents.length;
      if (parents.length > MAX_COMMIT_PARENTS || edges > MAX_GRAPH_EDGES) throw new Error("Release commit graph exceeds parent/edge limits (4096 per commit, 1000000 total)");
      graph.set(sha, parents.filter(parent => selected.has(parent)));
      details.set(sha, { sha, parents, authorName: fields[i + 2]!.trim(), message: fields[i + 3]! + "\n", ordinal: 0 });
    }
  }
  return { graph, details };
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
  const { graph, details } = selectedCommitGraph(repository, targetSha, baseSha);
  const ordered = deterministicTopoOrder(graph);
  return ordered.map((sha, ordinal) => ({ ...details.get(sha)!, ordinal }));
}
