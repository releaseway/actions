import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import {
  resolveActionInputs,
  type ActionInputs,
} from "./contract.ts";

interface SpawnResult {
  status: number | null;
  error?: Error;
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

export function scaffoldSupports(inputs: ActionInputs): void {
  if (inputs.notesPreview) {
    throw new Error(
      "notes-preview is not available until lifecycle integration is implemented",
    );
  }
  if (inputs.notesExisting !== "auto") {
    throw new Error(
      "notes-existing values other than auto are not available until lifecycle integration is implemented",
    );
  }
  if (inputs.notes !== "none" && inputs.notes !== "file") {
    throw new Error(
      `notes mode ${inputs.notes} is not available until release-note generation is implemented`,
    );
  }
}

export function runAction(
  options: {
    env?: NodeJS.ProcessEnv;
    actionPath?: string;
    argv?: readonly string[];
    spawnPublisher?: SpawnPublisher;
    nodeVersion?: string;
  } = {},
): void {
  const env = options.env ?? process.env;
  requireNode24(options.nodeVersion ?? process.versions.node);
  const inputs = resolveActionInputs(env);
  scaffoldSupports(inputs);

  const actionPath = resolveActionPath(
    options.actionPath,
    env,
    options.argv ?? process.argv,
  );
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    INPUT_NOTES: inputs.notes,
    INPUT_NOTES_CONFIG: inputs.notesConfig,
    INPUT_NOTES_FILE: inputs.notesFile,
    INPUT_NOTES_EXISTING: inputs.notesExisting,
    INPUT_NOTES_PREVIEW: String(inputs.notesPreview),
    RELEASE_ACTIONS_NODE: process.execPath,
    RELEASE_ACTIONS_ENGINE: resolve(actionPath, "dist/engine.js"),
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
}
