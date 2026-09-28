export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function githubErrorCommand(error: unknown): string {
  const message = errorMessage(error)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `::error::${message}`;
}
