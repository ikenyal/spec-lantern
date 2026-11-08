// Feature: spec-lantern — doc comments must not undercount the registered tools
// (cleanup 1)
//
// `compare_predictions` made the MCP_Server register FIVE tools. The doc
// comments in index.ts, bin/server.ts, and mcp-server.ts previously said the
// server registers "four tools" (or enumerated only three/four). These tests
// pin those comments so no comment silently undercounts the tool surface again.
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
  // The five tools the server registers; every enumerating doc comment should
  // be able to name them.
  const FIVE_TOOLS = [
    "execute_properties",
    "replay_counterexample",
    "apply_fixes_and_reexecute",
    "lock_prediction",
    "compare_predictions",
  ];

  for (const file of ["index.ts", "bin/server.ts", "mcp-server.ts"]) {
    it(`${file} never describes the server as registering "four tools"`, async () => {
      const text = await readSource(file);
      // Catch "four tools", "the four tools", "registers four", etc. (The
      // unrelated "four-way switch" over verdict products in apply-fixes is in a
      // different file and is not a tool count.)
      expect(text).not.toMatch(/\bfour\b[^\n.]*\btools?\b/i);
      expect(text).not.toMatch(/\bregisters\b[^\n.]*\bfour\b/i);
    });
  }

  it("index.ts and bin/server.ts say the server registers FIVE tools and name all five", async () => {
    for (const file of ["index.ts", "bin/server.ts"]) {
      const text = await readSource(file);
      expect(text).toMatch(/\bfive\b[^\n.]*\btools?\b/i);
      for (const tool of FIVE_TOOLS) {
        expect(text).toContain(tool);
      }
    }
  });

  it("mcp-server.ts names all five registered tools in its scope comment", async () => {
    const text = await readSource("mcp-server.ts");
    for (const tool of FIVE_TOOLS) {
      expect(text).toContain(tool);
    }
  });
});
