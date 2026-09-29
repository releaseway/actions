export const MAX_NOTES_BYTES = 1024 * 1024;

const UNSUPPORTED_CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export function assertSupportedText(
  value: string,
  label: string,
): void {
  if (UNSUPPORTED_CONTROL.test(value)) {
    throw new Error(`${label} contains unsupported control characters`);
  }
}

export function assertNotesSize(
  value: string,
  label = "release notes",
): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_NOTES_BYTES) {
    throw new Error(
      `${label} exceeds maximum size ${MAX_NOTES_BYTES} bytes`,
    );
  }
}
