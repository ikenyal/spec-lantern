// Feature: spec-lantern — doc comments must not undercount the registered tools
// (cleanup 1; extended for supersede_prediction_lock)
//
// `compare_predictions` took the MCP_Server to FIVE tools, and
// `supersede_prediction_lock` (the GAP-1 lock-supersede tool) took it to SIX.
// The doc comments in index.ts, bin/server.ts, and mcp-server.ts previously said
// the server registers "four tools" (or "five"), undercounting the real surface.
// These tests pin those comments to SIX so no comment silently undercounts the
// tool surface again.
//
// We read the SOURCE text (not transpiled output) so the assertions are about
// the authored comments reviewers read.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = dirname(fileURLToPath(import.meta.url));

async function readSource(relative: string): Promise<string> {
  return readFile(join(srcDir, relative), "utf8");
}

describe("tool-count doc comments (cleanup 1)", () => {
  // The six tools the server registers; every enumerating doc comment should
  // be able to name them.
  const SIX_TOOLS = [
    "execute_properties",
    "replay_counterexample",
    "apply_fixes_and_reexecute",
    "lock_prediction",
    "supersede_prediction_lock",
    "compare_predictions",
  ];

  for (const file of ["index.ts", "bin/server.ts", "mcp-server.ts"]) {
    it(`${file} never undercounts the server as registering "four" or "five tools"`, async () => {
      const text = await readSource(file);
      // Catch "four tools", "the four tools", "registers four", and the same for
      // "five", so no comment lands below the real count of six. (The unrelated
      // "four-way switch" over verdict products in apply-fixes is in a different
      // file and is not a tool count.)
      expect(text).not.toMatch(/\bfour\b[^\n.]*\btools?\b/i);
      expect(text).not.toMatch(/\bregisters\b[^\n.]*\bfour\b/i);
      expect(text).not.toMatch(/\bfive\b[^\n.]*\btools?\b/i);
      expect(text).not.toMatch(/\bregisters\b[^\n.]*\bfive\b/i);
    });
  }

  it("index.ts and bin/server.ts say the server registers SIX tools and name all six", async () => {
    for (const file of ["index.ts", "bin/server.ts"]) {
      const text = await readSource(file);
      expect(text).toMatch(/\bsix\b[^\n.]*\btools?\b/i);
      for (const tool of SIX_TOOLS) {
        expect(text).toContain(tool);
      }
    }
  });

  it("mcp-server.ts names all six registered tools in its scope comment", async () => {
    const text = await readSource("mcp-server.ts");
    for (const tool of SIX_TOOLS) {
      expect(text).toContain(tool);
    }
  });
});
