import { createHash } from "node:crypto";
export interface FileRecord { path: string; size: number; sha256: string; origin: "selected" | "base"; from?: string }
export function ordered(files: FileRecord[]): FileRecord[] {
  return files.slice().sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
export function contentDigest(files: FileRecord[]): string {
  const bytes = JSON.stringify(ordered(files).map(f => [f.path, f.size, f.sha256]));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
