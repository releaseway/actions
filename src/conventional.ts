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

function splitBodyAndFooters(lines: string[]): {
  body: string[];
  breaking: string[];
} {
  const breaking: string[] = [];
  const body: string[] = [];
  let activeBreaking: string[] | null = null;

  for (const line of lines) {
    const match = line.match(BREAKING_FOOTER);
    if (match) {
      activeBreaking = [match[1] ?? ""];
      breaking.push(activeBreaking[0]!);
      continue;
    }

    if (activeBreaking) {
      if (FOOTER.test(line)) {
        activeBreaking = null;
        continue;
      }
      if (line.trim() === "") {
        activeBreaking = null;
        continue;
      }
      activeBreaking.push(line);
      breaking[breaking.length - 1] = activeBreaking.join("\n").trim();
      continue;
    }

    if (!FOOTER.test(line)) body.push(line);
  }

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

  if (!match) {
    const first = header.trim() || "(empty commit message)";
    return {
      conventional: false,
      type: null,
      scope: null,
      description: first,
      body: lines.slice(1).join("\n").trim(),
      breaking: false,
      breakingDescriptions: [],
    };
  }

  const rest = splitBodyAndFooters(lines.slice(1));
  const breaking = Boolean(match[3]) || rest.breaking.length > 0;
  return {
    conventional: true,
    type: match[1]!.toLowerCase(),
    scope: match[2] ?? null,
    description: match[4]!.trim(),
    body: rest.body.join("\n").trim(),
    breaking,
    breakingDescriptions: rest.breaking.filter(Boolean),
  };
}
