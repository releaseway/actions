import assert from "node:assert/strict";
import test from "node:test";

import { publicContract } from "../src/contract.ts";

test("engine contract document is versioned and deterministic", () => {
  assert.deepEqual(publicContract(), {
    schemaVersion: 1,
    notesModes: [
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
    ],
    notesExistingPolicies: ["auto", "verify", "preserve"],
    defaults: {
      notes: "standard",
      notesExisting: "auto",
      notesPreview: false,
    },
  });
});
