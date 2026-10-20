import { runPrepare } from "./prepare-action.ts";
import process from "node:process";

import { publicContract } from "./contract.ts";
import { errorMessage } from "./errors.ts";
import { verifyReleaseBody } from "./prepare.ts";
import { readReleaseConfig } from "./release-config.ts";
import { resolveSeriesLatest } from "./release-execution.ts";

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command === "release-prepare") {
    runPrepare();
    return;
  }

  if (command === "resolve-series-latest") {
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const config = readReleaseConfig(workspace, process.env.INPUT_RELEASE_CONFIG || ".github/releaseway.yml");
    process.stdout.write(resolveSeriesLatest(workspace, config, process.env.INPUT_TAG || "", process.env.INPUT_COMMIT || "") + "\n");
    return;
  }
  if (command === "contract") {
    process.stdout.write(JSON.stringify(publicContract()) + "\n");
    return;
  }

  if (command === "verify-release-body") {
    const repository = argv[1];
    const releaseId = Number(argv[2]);
    const expectedPath = argv[3];
    if (
      !repository ||
      !Number.isInteger(releaseId) ||
      releaseId <= 0 ||
      !expectedPath
    ) {
      throw new Error(
        "verify-release-body requires repository, release id, and expected file",
      );
    }
    await verifyReleaseBody({
      repository,
      releaseId,
      expectedPath,
    });
    return;
  }

  throw new Error(
    command
      ? `unknown notes-engine command: ${command}`
      : "notes-engine command is required",
  );
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
