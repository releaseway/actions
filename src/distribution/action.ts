import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "./inputs.ts";
import { input, options } from "./inputs.ts";
import { selectLocal } from "./local.ts";
import { inside } from "./paths.ts";
import { copyFile } from "./copy.ts";
import { contentDigest, ordered, type FileRecord } from "./report.ts";
import { prepareRelease } from "./release.ts";
import type { ReleaseClient } from "./gh.ts";
export async function distribute(env: Environment = process.env, client?: ReleaseClient) {
  const o = options(env);
  const deadline = Date.now() + 600_000;
  const remote = input(env, "tag") ? await prepareRelease(o, env, deadline, client) : undefined;
  if (!remote && (input(env,"repository") || input(env,"commit") || (input(env,"verification") && input(env,"verification") !== "digest"))) throw new Error("Remote inputs require tag");
  const { selections, root } = remote ?? await selectLocal(o, deadline);
  let stage: string | undefined;
  try {
    const temp = await realpath(o.temp);
    stage = await mkdtemp(join(temp, "releaseway-distribute-"));
    if (inside(root, stage) || inside(stage, root)) throw new Error("Output must be separate from input root");
    const path = join(stage, "site"); await mkdir(path, { mode: 0o755 });
    const files: FileRecord[] = []; let total = 0;
    for (const s of selections) {
      const file = await copyFile(s.source, join(path, s.to), s.to, Math.min(o.maxFile, o.maxTotal - total), "selected", deadline);
      if (remote) {
        const expected = remote.source.assets.find(a => a.name === s.from);
        if (!expected || expected.digest !== `sha256:${file.sha256}` || expected.size !== file.size) throw new Error("Final copy does not match Release asset");
      }
      total += file.size; files.push({ ...file, from: s.from });
    }
    await remote?.verifySnapshot();
    const digest = contentDigest(files);
    const report = join(stage, "report.json");
    const bytes = JSON.stringify({ schema: 1, source: remote?.source ?? { kind: "local", verification: "digest" }, base: false, digest, files: ordered(files) }, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > 32 * 1024 ** 2) throw new Error("Report exceeds 32 MiB");
    await writeFile(report, bytes, { mode: 0o600 });
    if (env.GITHUB_OUTPUT) {
      if (/[\r\n]/.test(path + report)) throw new Error("Invalid output directory");
      await appendFile(env.GITHUB_OUTPUT, `path=${path}\nreport=${report}\ndigest=${digest}\n`);
    }
    return { path, report, digest };
  } catch (error) { if (stage) await rm(stage, { recursive: true, force: true }); throw error; }
  finally { await remote?.cleanup(); }
}
