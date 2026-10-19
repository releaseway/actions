import { createHash } from "node:crypto";
import { mkdir, open, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileRecord } from "./report.ts";
export async function copyFile(source: string, target: string, path: string, max: number, origin: "selected" | "base" = "selected", deadline = Date.now() + 600_000): Promise<FileRecord> {
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  const input = await open(source, "r");
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > max) throw new Error("Input is not a regular file within the byte limit");
    output = await open(target, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      if (Date.now() > deadline) throw new Error("Distribution exceeded its deadline");
      if (Date.now() > deadline) throw new Error("Distribution exceeded its deadline");
      size += chunk.length;
      if (size > max) throw new Error("File exceeds byte limit");
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    const after = await input.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== before.size) throw new Error("Source changed while copying");
    await output.close(); output = undefined;
    const sha256 = hash.digest("hex");
    const actual = await hashFile(target, max, deadline);
    if (actual.size !== size || actual.sha256 !== sha256) throw new Error("Copied bytes do not match");
    await chmod(target, 0o644 | (before.mode & 0o111));
    return { path, size, sha256, origin };
  } finally { await output?.close(); await input.close(); }
}
export async function hashFile(path: string, max = 8 * 1024 ** 3, deadline = Date.now() + 600_000): Promise<{ size: number; sha256: string }> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (Date.now() > deadline) throw new Error("Distribution exceeded its deadline");
      size += chunk.length;
      if (size > max) throw new Error("File exceeds byte limit");
      hash.update(chunk);
    }
    return { size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}
