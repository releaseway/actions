import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTES_MODES,
  resolveActionInputs,
} from "../src/contract.ts";

test("notes defaults to standard with explicit lifecycle defaults", () => {
  assert.deepEqual(resolveActionInputs({}), {
    notes: "standard",
    notesConfig: "",
    notesFile: "",
    notesExisting: "auto",
    notesPreview: false,
    prerelease: false,
  });
});

test("catalog exposes the selected public modes", () => {
  assert.deepEqual(NOTES_MODES, [
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
  ]);
});

test("file mode requires the file and rejects generation config", () => {
  assert.throws(
    () => resolveActionInputs({ INPUT_NOTES: "file" }),
    /notes-file is required/,
  );
  assert.throws(
    () =>
      resolveActionInputs({
        INPUT_NOTES: "file",
        INPUT_NOTES_FILE: "notes.md",
        INPUT_NOTES_CONFIG: "release.yml",
      }),
    /notes-config is not supported/,
  );
  assert.deepEqual(
    resolveActionInputs({
      INPUT_NOTES: "file",
      INPUT_NOTES_FILE: " notes.md ",
    }),
    {
      notes: "file",
      notesConfig: "",
      notesFile: "notes.md",
      notesExisting: "auto",
      notesPreview: false,
      prerelease: false,
    },
  );
});

test("notes-file is rejected outside explicit file mode", () => {
  assert.throws(
    () =>
      resolveActionInputs({
        INPUT_NOTES: "none",
        INPUT_NOTES_FILE: "notes.md",
      }),
    /notes-file requires notes=file/,
  );
});

test("none rejects configuration and booleans are not mode aliases", () => {
  assert.throws(
    () =>
      resolveActionInputs({
        INPUT_NOTES: "none",
        INPUT_NOTES_CONFIG: "release.yml",
      }),
    /notes-config is not supported/,
  );
  assert.throws(
    () => resolveActionInputs({ INPUT_NOTES: "true" }),
    /notes must be one of/,
  );
  assert.throws(
    () => resolveActionInputs({ INPUT_NOTES: "false" }),
    /notes must be one of/,
  );
});

test("existing policy, preview, and prerelease are strict booleans/enums", () => {
  assert.equal(
    resolveActionInputs({ INPUT_NOTES_EXISTING: "verify" }).notesExisting,
    "verify",
  );
  assert.equal(
    resolveActionInputs({ INPUT_NOTES_PREVIEW: "true" }).notesPreview,
    true,
  );
  assert.throws(
    () => resolveActionInputs({ INPUT_NOTES_EXISTING: "repair" }),
    /notes-existing must be one of/,
  );
  assert.equal(
    resolveActionInputs({ INPUT_PRERELEASE: "true" }).prerelease,
    true,
  );
  assert.throws(
    () => resolveActionInputs({ INPUT_NOTES_PREVIEW: "yes" }),
    /notes-preview must be true or false/,
  );
  assert.throws(
    () => resolveActionInputs({ INPUT_PRERELEASE: "yes" }),
    /prerelease must be true or false/,
  );
});
