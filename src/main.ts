import { runAction } from "./action.ts";
import { errorMessage, githubErrorCommand } from "./errors.ts";

void runAction().catch((error) => {
  console.error(errorMessage(error));
  process.stdout.write(githubErrorCommand(error) + "\n");
  process.exitCode = 1;
});
