import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Environment } from "./inputs.ts";
export interface ReleaseClient {
  json(endpoint: string): Promise<any>;
  download(endpoint: string, path: string, maximum: number): Promise<void>;
  verify(tag: string, path: string, repository: string): Promise<void>;
}
export class GhClient implements ReleaseClient {
  private env: Environment;
  private deadline: number;
  private command: string;
  private prefix: string[];
  constructor(token: string, cache: string, deadline = Date.now() + 600_000, env: Environment = process.env,
    command = "gh", prefix: string[] = []) {
    this.deadline = deadline; this.command = command; this.prefix = prefix;
    if (!token) throw new Error("Release reads require token (defaults to github.token) with contents:read");
    this.env = { ...env, GH_TOKEN: token, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_CACHE_DIR: cache };
  }
  private async run(args: string[], file?: string, maximum = 16 * 1024 ** 2): Promise<Buffer> {
    const remaining = Math.min(file ? 120_000 : 30_000, this.deadline - Date.now());
    if (remaining <= 0) throw new Error("Distribution exceeded its deadline");
    const child = spawn(this.command, [...this.prefix, ...args], { env: this.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), remaining);
    // Never forward raw CLI stderr: it may contain credentials or signed URLs.
    child.stderr.resume();
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("GitHub CLI unavailable; install gh with Release verification support")));
      child.once("close", code => code === 0 ? resolve() : reject(new Error("GitHub CLI operation failed; check token permissions, gh capability, source and timeout")));
    });
    // Attach immediately so a failed spawn cannot reject before the stream finishes.
    void closed.catch(() => {});
    try {
      let size = 0;
      const bounded = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > maximum ? new Error("GitHub response exceeds byte limit") : null, chunk);
      } });
      const chunks: Buffer[] = [];
      if (file) await pipeline(child.stdout, bounded, createWriteStream(file, { flags: "wx", mode: 0o600 }));
      else { for await (const chunk of child.stdout.pipe(bounded)) chunks.push(Buffer.from(chunk)); }
      await closed;
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }
  async json(endpoint: string): Promise<any> {
    const bytes = await this.run(["api", "--hostname", "github.com", "-H", "Accept: application/vnd.github+json", endpoint]);
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Invalid GitHub JSON response"); }
  }
  async download(endpoint: string, path: string, maximum: number): Promise<void> {
    await this.run(["api", "--hostname", "github.com", "-H", "Accept: application/octet-stream", endpoint], path, maximum);
  }
  async verify(tag: string, path: string, repository: string): Promise<void> {
    await this.run(["release", "verify-asset", "--repo", `github.com/${repository}`, "--format", "json", "--", tag, path]);
  }
}
