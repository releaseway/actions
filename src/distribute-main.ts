import { distribute } from "./distribution/action.ts";
import { githubErrorCommand } from "./errors.ts";
void distribute().catch(error => {
  process.stdout.write(githubErrorCommand(error) + "\n");
  process.exitCode = 1;
});
