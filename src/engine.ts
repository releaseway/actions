import process from "node:process";

import { publicContract } from "./contract.ts";
import { errorMessage } from "./errors.ts";
import { verifyReleaseBody } from "./prepare.ts";

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
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
