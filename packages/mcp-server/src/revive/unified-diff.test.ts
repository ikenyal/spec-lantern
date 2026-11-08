// Feature: spec-lantern — line-ending-preserving unified diff (change 4)
//
// unifiedDiffForFile must preserve CRLF: a write over CRLF original content
// yields a diff whose lines end in \r\n, never normalized to LF.

import { describe, expect, it } from "vitest";
import {
  splitLinesPreservingEndings,
  unifiedDiffForFile,
} from "./unified-diff.js";

describe("unifiedDiffForFile (change 4)", () => {
  it("preserves CRLF line endings in the diff body", () => {
    const before = "const a = 1;\r\nconst reverse = true;\r\n";
    const after = "const a = 1;\r\nconst reverse = false;\r\n";

    const diff = unifiedDiffForFile("src/order.ts", before, after);

    // The changed lines keep their CRLF endings; nothing is normalized to LF.
    expect(diff).toContain("-const reverse = true;\r\n");
    expect(diff).toContain("+const reverse = false;\r\n");
    // The unchanged context line is also CRLF-terminated.
    expect(diff).toContain(" const a = 1;\r\n");
    // Standard unified headers are present.
    expect(diff).toContain("--- a/src/order.ts");
    expect(diff).toContain("+++ b/src/order.ts");
  });

  it("splits lines keeping terminators and round-trips exactly", () => {
    const text = "a\r\nb\nc";
    expect(splitLinesPreservingEndings(text)).toEqual(["a\r\n", "b\n", "c"]);
    expect(splitLinesPreservingEndings(text).join("")).toBe(text);
  });

  it("diffs a newly created file as empty → contents", () => {
    const diff = unifiedDiffForFile("src/new.ts", "", "export {};\n");
    expect(diff).toContain("@@ -0,0 +1,1 @@");
    expect(diff).toContain("+export {};\n");
  });

  it("returns empty string when nothing changed", () => {
    expect(unifiedDiffForFile("x", "same\n", "same\n")).toBe("");
  });

  it("marks a missing final newline without normalizing", () => {
    const diff = unifiedDiffForFile("x", "a", "b");
    expect(diff).toContain("\\ No newline at end of file");
  });
});
