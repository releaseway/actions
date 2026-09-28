import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import {
  resolveActionInputs,
  type ActionInputs,
} from "./contract.ts";
import {
  GhCliApi,
  type GitHubApi,
  type ReleaseSnapshot,
} from "./github.ts";
import {
  observeExistingBody,
  prepareNotes,
  type PreparedNotes,
} from "./prepare.ts";

interface SpawnResult {
  status: number | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
}

type SpawnPublisher = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  },
) => SpawnResult;

type AppendOutput = (
  path: string,
  data: string,
  options: { encoding: "utf8" },
) => void;

function nodeMajor(version: string): number {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  if (!Number.isInteger(major)) {
    throw new Error(`could not parse Node.js version: ${version}`);
  }
  return major;
}

export function requireNode24(version = process.versions.node): void {
  if (nodeMajor(version) < 24) {
    throw new Error(
      `releaseway/actions requires Node.js 24 or newer; found ${version}`,
    );
  }
}

function requiredEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function resolveActionPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  argv: readonly string[] = process.argv,
): string {
  if (explicit) return resolve(explicit);
  if (env.GITHUB_ACTION_PATH) return resolve(env.GITHUB_ACTION_PATH);

  const entrypoint = argv[1];
  if (!entrypoint) {
    throw new Error("unable to determine action installation path");
  }
  return resolve(dirname(entrypoint), "..");
}

function writeOutputs(
  outputPath: string,
  entries: Record<string, string>,
  appendOutput: AppendOutput,
): void {
  const data = Object.entries(entries)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  appendOutput(outputPath, data, { encoding: "utf8" });
}

function shouldPreserve(
  existing: ReleaseSnapshot,
  inputs: ActionInputs,
): boolean {
  return (
    inputs.notesExisting === "preserve" ||
    (inputs.notesExisting === "auto" && !existing.draft)
  );
}

function verifyPublishedTitle(
  existing: ReleaseSnapshot,
  env: NodeJS.ProcessEnv,
): void {
  const requested = (env.INPUT_TITLE ?? "").trim();
  if (requested && requested !== existing.name) {
    throw new Error(
      `existing published release title does not match requested title: expected=${requested} actual=${existing.name}`,
    );
  }
}

function defaultIdentityCheck(
  workspace: string,
  repository: string,
): void {
  const origin = spawnSync(
    "git",
    ["-C", workspace, "remote", "get-url", "origin"],
    { encoding: "utf8" },
  );
  if (origin.status !== 0) {
    throw new Error("could not resolve checkout origin");
  }
  const remote = (origin.stdout ?? "").trim();
  const resolved = spawnSync(
    "gh",
    ["repo", "view", remote, "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { encoding: "utf8", env: process.env },
  );
  if (resolved.status !== 0) {
    throw new Error("could not resolve checkout repository identity");
  }
  const actual = (resolved.stdout ?? "").trim();
  if (actual !== repository) {
    throw new Error(
      `checkout repository does not match GITHUB_REPOSITORY: checkout=${actual} expected=${repository}`,
    );
  }
}

export async function runAction(
  options: {
    env?: NodeJS.ProcessEnv;
    actionPath?: string;
    argv?: readonly string[];
    spawnPublisher?: SpawnPublisher;
    appendOutput?: AppendOutput;
    nodeVersion?: string;
    api?: GitHubApi;
    identityCheck?: (workspace: string, repository: string) => void;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  requireNode24(options.nodeVersion ?? process.versions.node);
  const inputs = resolveActionInputs(env);
  const repository = requiredEnvironment(env, "GITHUB_REPOSITORY");
  const outputPath = requiredEnvironment(env, "GITHUB_OUTPUT");
  const tag = requiredEnvironment(env, "INPUT_TAG");
  const commit = requiredEnvironment(env, "INPUT_COMMIT").toLowerCase();
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const runnerTemp = env.RUNNER_TEMP;
  const actionPath = resolveActionPath(
    options.actionPath,
    env,
    options.argv ?? process.argv,
  );
  const api = options.api ?? new GhCliApi();
  const appendOutput = options.appendOutput ?? appendFileSync;
  const existing = await api.releaseByTag(repository, tag);

  if (existing && !existing.draft) {
    verifyPublishedTitle(existing, env);
  }

  let prepared: PreparedNotes;
  let notesState: "prepared" | "verified" | "preserved";
  let preserveBody = false;

  if (inputs.notesPreview) {
    (options.identityCheck ?? defaultIdentityCheck)(
      workspace,
      repository,
    );
    prepared = await prepareNotes({
      inputs,
      repository,
      tag,
      commit,
      workspace,
      runnerTemp,
      api,
    });
    writeOutputs(
      outputPath,
      {
        state: "preview",
        "release-url": "",
        "notes-path": prepared.notesPath,
        "notes-report": prepared.reportPath,
        "notes-state": "prepared",
      },
      appendOutput,
    );
    return;
  }

  if (existing && shouldPreserve(existing, inputs)) {
    prepared = await observeExistingBody({
      mode: inputs.notes,
      body: existing.body,
      runnerTemp,
      releaseId: existing.id,
      draft: existing.draft,
    });
    notesState = "preserved";
    preserveBody = true;
  } else {
    prepared = await prepareNotes({
      inputs,
      repository,
      tag,
      commit,
      workspace,
      runnerTemp,
      api,
    });
    if (existing && existing.body !== prepared.body) {
      throw new Error(
        `existing release notes do not match requested notes for ${tag}`,
      );
    }
    notesState = "verified";
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    INPUT_NOTES: inputs.notes,
    INPUT_NOTES_CONFIG: inputs.notesConfig,
    INPUT_NOTES_FILE: preserveBody ? "" : prepared.notesPath,
    INPUT_NOTES_EXISTING: inputs.notesExisting,
    INPUT_NOTES_PREVIEW: "false",
    RELEASE_ACTIONS_PRESERVE_BODY: preserveBody ? "true" : "false",
    RELEASE_ACTIONS_ACCEPTED_BODY_FILE: preserveBody
      ? prepared.notesPath
      : "",
    RELEASE_ACTIONS_NODE: process.execPath,
    RELEASE_ACTIONS_ENGINE: resolve(actionPath, "dist/engine.cjs"),
  };

  const spawnPublisher =
    options.spawnPublisher ??
    ((command, args, spawnOptions) =>
      spawnSync(command, [...args], spawnOptions));

  const result = spawnPublisher(
    "bash",
    [resolve(actionPath, "scripts/release.sh")],
    {
      cwd: workspace,
      env: childEnv,
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `release publisher exited with status ${result.status ?? "unknown"}`,
    );
  }

  writeOutputs(
    outputPath,
    {
      "notes-path": prepared.notesPath,
      "notes-report": prepared.reportPath,
      "notes-state": notesState,
    },
    appendOutput,
  );
}
