import { distribute } from "./distribution/action.ts";
import { runPages } from "./distribution/pages.ts";
import { githubErrorCommand } from "./errors.ts";
void (process.env.INPUT_OPERATION ? runPages() : distribute()).catch(error => {
  process.stdout.write(githubErrorCommand(error) + "\n");
  process.exitCode = 1;
});
