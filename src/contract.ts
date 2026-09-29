export const NOTES_MODES = [
  "standard",
  "compact",
  "conventional",
  "changelog",
  "detailed",
  "scoped",
  "pull-requests",
  "hybrid",
  "github",
  "file",
  "none",
] as const;

export const NOTES_EXISTING_POLICIES = [
  "auto",
  "verify",
  "preserve",
] as const;

export type NotesMode = (typeof NOTES_MODES)[number];
export type NotesExistingPolicy =
  (typeof NOTES_EXISTING_POLICIES)[number];

export interface ActionInputs {
  notes: NotesMode;
  notesConfig: string;
  notesFile: string;
  notesExisting: NotesExistingPolicy;
  notesPreview: boolean;
  prerelease: boolean;
}

function inputName(name: string): string {
  return "INPUT_" + name.toUpperCase().replaceAll("-", "_");
}

function input(env: NodeJS.ProcessEnv, name: string): string {
  return env[inputName(name)] ?? "";
}

function parseEnum<const T extends readonly string[]>(
  name: string,
  raw: string,
  allowed: T,
): T[number] {
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T[number];
  }
  throw new Error(
    `${name} must be one of: ${allowed.join(", ")}`,
  );
}

function parseBoolean(name: string, raw: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function resolveActionInputs(
  env: NodeJS.ProcessEnv = process.env,
): ActionInputs {
  const rawNotes = input(env, "notes").trim();
  const notes = parseEnum(
    "notes",
    rawNotes === "" ? "standard" : rawNotes,
    NOTES_MODES,
  );
  const notesConfig = input(env, "notes-config").trim();
  const notesFile = input(env, "notes-file").trim();
  const notesExisting = parseEnum(
    "notes-existing",
    input(env, "notes-existing").trim() || "auto",
    NOTES_EXISTING_POLICIES,
  );
  const notesPreview = parseBoolean(
    "notes-preview",
    input(env, "notes-preview").trim() || "false",
  );
  const prerelease = parseBoolean(
    "prerelease",
    input(env, "prerelease").trim() || "false",
  );

  if (notes === "file") {
    if (!notesFile) {
      throw new Error("notes-file is required when notes=file");
    }
    if (notesConfig) {
      throw new Error("notes-config is not supported when notes=file");
    }
  } else if (notesFile) {
    throw new Error("notes-file requires notes=file");
  }

  if (notes === "none" && notesConfig) {
    throw new Error("notes-config is not supported when notes=none");
  }

  return {
    notes,
    notesConfig,
    notesFile,
    notesExisting,
    notesPreview,
    prerelease,
  };
}

export function publicContract(): object {
  return {
    schemaVersion: 1,
    notesModes: [...NOTES_MODES],
    notesExistingPolicies: [...NOTES_EXISTING_POLICIES],
    defaults: {
      notes: "standard",
      notesExisting: "auto",
      notesPreview: false,
    },
  };
}
