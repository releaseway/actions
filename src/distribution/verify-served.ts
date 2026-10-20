import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { publicPath } from "./paths.ts";
import type { FileRecord } from "./report.ts";

class PagesPolicyError extends Error {}

async function matches(response: Response, file: FileRecord, signal: AbortSignal): Promise<boolean> {
  const hash = createHash("sha256");
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        // A stale larger response is transient; stop consuming it immediately.
        if (size > file.size) return false;
        hash.update(value);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return size === file.size && hash.digest("hex") === file.sha256;
}

export async function verifyServed(
  page: string,
  files: FileRecord[],
  request: typeof fetch = fetch,
  deadline = Date.now() + 300_000,
) {
  const base = new URL(page.endsWith("/") ? page : page + "/");
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new PagesPolicyError("Pages URL must be an HTTPS origin/base path");
  }
  let cursor = 0;
  const stop = new AbortController();
  async function one(file: FileRecord) {
    publicPath(file.path);
    const target = new URL(file.path.split("/").map(encodeURIComponent).join("/"), base);
    while (Date.now() < deadline && !stop.signal.aborted) {
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now())))]);
      let url = target;
      let response: Response | undefined;
      try {
        for (let redirects = 0; redirects <= 5; redirects++) {
          if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) {
            throw new PagesPolicyError("Redirect leaves Pages origin/base path or contains credentials");
          }
          response = await request(url, { redirect: "manual", signal, headers: { "Accept-Encoding": "identity", "Cache-Control": "no-cache" } });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirects === 5) throw new PagesPolicyError("Invalid Pages redirect");
          try { url = new URL(location, url); }
          catch { throw new PagesPolicyError("Invalid Pages redirect URL"); }
        }
        if (response?.status === 200) {
          if (await matches(response, file, signal)) return;
        } else {
          await response?.body?.cancel();
        }
      } catch (error) {
        if (stop.signal.aborted) throw stop.signal.reason;
        if (error instanceof PagesPolicyError) throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(1000, remaining), undefined, { signal: stop.signal });
    }
    throw new Error("Served bytes did not converge before the verification deadline");
  }
  const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
    while (cursor < files.length && !stop.signal.aborted) await one(files[cursor++]);
  });
  try { await Promise.all(workers); }
  catch (error) {
    stop.abort(error);
    await Promise.allSettled(workers);
    throw error;
  }
}
