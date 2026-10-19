import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { publicPath } from "./paths.ts";
import type { FileRecord } from "./report.ts";
export async function verifyServed(page: string, files: FileRecord[], request: typeof fetch = fetch, deadline = Date.now()+300_000) {
  const base = new URL(page.endsWith("/")?page:page+"/");
  if (base.protocol!=="https:" || base.username || base.password || base.search || base.hash) throw new Error("Pages URL must be an HTTPS origin/base path");
  let cursor=0;
  const stop=new AbortController();
  async function one(file: FileRecord) {
    publicPath(file.path);
    const target = new URL(file.path.split("/").map(encodeURIComponent).join("/"),base);
    while(Date.now()<deadline && !stop.signal.aborted) {
      const signal=AbortSignal.any([stop.signal,AbortSignal.timeout(Math.max(1,Math.min(30_000,deadline-Date.now())))]);
      let url=target, response: Response | undefined;
      try {
        for(let redirects=0;redirects<=5;redirects++) {
          if(url.origin!==base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("Redirect leaves Pages origin/base path");
          response=await request(url,{redirect:"manual",signal,headers:{"Accept-Encoding":"identity","Cache-Control":"no-cache"}});
          if(![301,302,303,307,308].includes(response.status))break;
          const location=response.headers.get("location");await response.body?.cancel();
          if(!location || redirects===5)throw new Error("Invalid Pages redirect");url=new URL(location,url);
        }
        if(response?.status===200) {
          const hash=createHash("sha256");let size=0;
          if(response.body) for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            size+=chunk.length;if(size>file.size)throw new Error("Served file exceeds expected size");hash.update(chunk);
          }
          if(size===file.size && hash.digest("hex")===file.sha256)return;
        } else await response?.body?.cancel();
      } catch(error) {
        if(stop.signal.aborted) throw stop.signal.reason;
        if(error instanceof Error && /Redirect|redirect|exceeds expected size/.test(error.message))throw error;
      }
      const remaining=deadline-Date.now();if(remaining>0)await delay(Math.min(1000,remaining));
    }
    throw new Error("Served bytes did not converge before the verification deadline");
  }
  const workers=Array.from({length:Math.min(4,files.length)},async()=>{while(cursor<files.length && !stop.signal.aborted){const file=files[cursor++];await one(file);}});
  try { await Promise.all(workers); } catch(error) { stop.abort(error); await Promise.allSettled(workers); throw error; }
}
