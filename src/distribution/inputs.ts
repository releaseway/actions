export type Environment = Record<string, string | undefined>;
export interface Options {
  workspace: string; temp: string; files: string[]; root: string; config: string;
  maxFile: number; maxTotal: number;
}
export function input(env: Environment, name: string): string {
  return (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}
function limit(value: string, fallback: number): number {
  if (!value) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Byte limits must be positive integers");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > 8 * 1024 ** 3) throw new Error("Byte limit exceeds 8 GiB");
  return n;
}
export function options(env: Environment): Options {
  if (!env.GITHUB_WORKSPACE || !env.RUNNER_TEMP) throw new Error("GITHUB_WORKSPACE and RUNNER_TEMP are required");
  const files = input(env, "files").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const config = input(env,"config");
  if ((files.length > 0) === Boolean(config)) throw new Error("Provide exactly one of files or config");
  return { workspace: env.GITHUB_WORKSPACE, temp: env.RUNNER_TEMP, files, config, root: input(env, "root"),
    maxFile: limit(input(env, "max-file-bytes"), 1024 ** 3),
    maxTotal: limit(input(env, "max-total-bytes"), 2 * 1024 ** 3) };
}
