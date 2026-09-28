import process from "node:process";

import { publicContract } from "./contract.ts";
import { errorMessage } from "./errors.ts";

function main(argv: readonly string[]): void {
  const command = argv[0];
  if (command === "contract") {
    process.stdout.write(JSON.stringify(publicContract()) + "\n");
    return;
  }

  throw new Error(
    command
      ? `unknown notes-engine command: ${command}`
      : "notes-engine command is required",
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
