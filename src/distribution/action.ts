import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "./inputs.ts";
import { options } from "./inputs.ts";
import { selectLocal } from "./local.ts";
import { inside } from "./paths.ts";
import { copyFile } from "./copy.ts";
import { contentDigest, ordered, type FileRecord } from "./report.ts";
export async function distribute(env: Environment = process.env) {
  const o = options(env);
  const deadline = Date.now() + 600_000;
  const { selections, root } = await selectLocal(o, deadline);
  const temp = await realpath(o.temp);
  const stage = await mkdtemp(join(temp, "releaseway-distribute-"));
  try {
    if (inside(root, stage) || inside(stage, root)) throw new Error("Output must be separate from input root");
    const path = join(stage, "site"); await mkdir(path, { mode: 0o755 });
    const files: FileRecord[] = []; let total = 0;
    for (const s of selections) {
      const file = await copyFile(s.source, join(path, s.to), s.to, Math.min(o.maxFile, o.maxTotal - total), "selected", deadline);
      total += file.size; files.push({ ...file, from: s.from });
    }
    const digest = contentDigest(files);
    const report = join(stage, "report.json");
    const bytes = JSON.stringify({ schema: 1, source: { kind: "local", verification: "digest" }, base: false, digest, files: ordered(files) }, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > 32 * 1024 ** 2) throw new Error("Report exceeds 32 MiB");
    await writeFile(report, bytes, { mode: 0o600 });
    if (env.GITHUB_OUTPUT) {
      if (/[\r\n]/.test(path + report)) throw new Error("Invalid output directory");
      await appendFile(env.GITHUB_OUTPUT, `path=${path}\nreport=${report}\ndigest=${digest}\n`);
    }
    return { path, report, digest };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
