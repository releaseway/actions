export interface ConventionalCommit {
  conventional: boolean;
  type: string | null;
  scope: string | null;
  description: string;
  body: string;
  breaking: boolean;
  breakingDescriptions: string[];
}

const HEADER =
  /^([A-Za-z][A-Za-z0-9._-]*)(?:\(([^)\r\n]+)\))?(!)?: (.+)$/;
const BREAKING_FOOTER = /^BREAKING(?: CHANGE|-CHANGE):\s*(.*)$/;
const FOOTER = /^[A-Za-z][A-Za-z0-9-]*(?: #[^\s]+|: .*)$/;

function parseFooterBlock(lines: readonly string[]): string[] | null {
  if (lines.length === 0 || !lines[0] || !(
    BREAKING_FOOTER.test(lines[0]) || FOOTER.test(lines[0])
  )) {
    return null;
  }

  const breaking: string[] = [];
  let activeBreaking = -1;
  let activeFooter = false;

  for (const line of lines) {
    if (line.trim() === "") return null;

    const breakingMatch = line.match(BREAKING_FOOTER);
    if (breakingMatch) {
      breaking.push((breakingMatch[1] ?? "").trim());
      activeBreaking = breaking.length - 1;
      activeFooter = true;
      continue;
    }

    if (FOOTER.test(line)) {
      activeBreaking = -1;
      activeFooter = true;
      continue;
    }

    if (!activeFooter) return null;
    if (activeBreaking >= 0) {
      breaking[activeBreaking] = (
        breaking[activeBreaking] + "\n" + line
      ).trim();
    }
  }

  return breaking.filter(Boolean);
}

function splitBodyAndFooters(lines: string[]): {
  body: string[];
  breaking: string[];
} {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  const trimmed = lines.slice(0, end);

  let footerStart = -1;
  let breaking: string[] = [];
  for (let index = trimmed.length - 1; index >= 1; index -= 1) {
    if (trimmed[index - 1]!.trim() !== "") continue;
    const parsed = parseFooterBlock(trimmed.slice(index));
    if (parsed === null) continue;
    footerStart = index;
    breaking = parsed;
  }

  const body =
    footerStart >= 0 ? trimmed.slice(0, footerStart - 1) : trimmed;
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();

  return { body, breaking };
}

export function parseConventionalCommit(
  message: string,
): ConventionalCommit {
  const normalized = message.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  const header = lines[0] ?? "";
  const match = header.match(HEADER);
  const rest = splitBodyAndFooters(lines.slice(1));

  if (!match) {
    const first = header.trim() || "(empty commit message)";
    return {
      conventional: false,
      type: null,
      scope: null,
      description: first,
      body: rest.body.join("\n").trim(),
      breaking: rest.breaking.length > 0,
      breakingDescriptions: rest.breaking,
    };
  }

  const breaking = Boolean(match[3]) || rest.breaking.length > 0;
  return {
    conventional: true,
    type: match[1]!.toLowerCase(),
    scope: match[2] ?? null,
    description: match[4]!.trim(),
    body: rest.body.join("\n").trim(),
    breaking,
    breakingDescriptions: rest.breaking,
  };
}
