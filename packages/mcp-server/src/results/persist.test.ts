// Feature: spec-lantern — verbatim tool-result persistence (change 2)
//
// writeToolResult must: create <specRoot>/results/ when missing, write the
// EXACT result object as JSON (verbatim), return the absolute written path, and
// name the file with the filesystem-safe UTC stamp (pinned via `now`).

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { utcStampForFilename, writeToolResult } from "./persist.js";

describe("writeToolResult (change 2)", () => {
  let specRoot: string;

  beforeEach(async () => {
    specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-persist-"));
  });

  afterEach(async () => {
    await rm(specRoot, { recursive: true, force: true });
  });

  it("derives a filesystem-safe, sortable UTC stamp (no ':' or '.')", () => {
    const stamp = utcStampForFilename(new Date("2026-11-08T20:54:49.867Z"));
    expect(stamp).toBe("2026-11-08T20-54-49-867Z");
    expect(stamp).not.toMatch(/[:.]/);
  });

  it("creates results/, writes the verbatim object, and returns the path", async () => {
    const result = {
      results: [{ propertyId: "property-1.claim-a", outcome: "VERDICT", verdict: "FAIL" }],
      executionContexts: {},
    };
    const now = () => new Date("2026-11-08T20:54:49.867Z");

    const path = await writeToolResult(specRoot, "execute_properties", result, now);

    // The file lives at the expected, UTC-stamped path under results/.
    expect(path).toBe(
      join(specRoot, "results", "2026-11-08T20-54-49-867Z-execute_properties.json"),
    );
    await expect(stat(join(specRoot, "results"))).resolves.toBeDefined();

    // The written contents are the EXACT object (verbatim), parse-equal.
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written).toEqual(result);
  });
});
