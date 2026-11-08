// Feature: spec-lantern — derive CorrectnessProperty objects from a spec root
// (change 1 core)
//
// deriveProperties/deriveProperty reconstruct properties from claims.json + the
// properties/ test files (honest kind: "function"), sorted by property number.
// Missing tag / missing claims.json surface as structured issues (no throw).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveProperties, deriveProperty } from "./index.js";

describe("deriveProperties / deriveProperty (change 1)", () => {
  let specRoot: string;

  beforeEach(async () => {
    specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-derive-"));
    await mkdir(join(specRoot, "properties"), { recursive: true });
    await writeFile(
      join(specRoot, "claims.json"),
      JSON.stringify({
        claims: [
          {
            id: "claim-b",
            description: "Reverse to have most recent month first",
            sourceFile: "X.tsx",
            commentRef: "L54",
          },
          {
            id: "claim-a",
            description: "Window covers the last 7 days",
            sourceFile: "Y.tsx",
            commentRef: "L10",
          },
        ],
      }),
    );
    // Two property files; written out of numeric order to prove sorting.
    await writeFile(
      join(specRoot, "properties", "property-2.claim-b.test.ts"),
      "// Feature: spec-lantern, Property 2: most recent month first\nexport {};\n",
    );
    await writeFile(
      join(specRoot, "properties", "property-1.claim-a.test.ts"),
      "// Feature: spec-lantern, Property 1: last 7 days including today\nexport {};\n",
    );
  });

  afterEach(async () => {
    await rm(specRoot, { recursive: true, force: true });
  });

  it("derives all properties sorted by number, with claim description as title", async () => {
    const result = await deriveProperties(specRoot);
    expect(result.issue).toBeNull();
    expect(result.properties).toEqual([
      {
        id: "property-1.claim-a",
        claimId: "claim-a",
        title: "Window covers the last 7 days",
        statement: "last 7 days including today",
        kind: "function",
        validatesRequirements: [],
      },
      {
        id: "property-2.claim-b",
        claimId: "claim-b",
        title: "Reverse to have most recent month first",
        statement: "most recent month first",
        kind: "function",
        validatesRequirements: [],
      },
    ]);
  });

  it("falls back to the tag text as title when the claim is absent", async () => {
    await writeFile(
      join(specRoot, "properties", "property-3.claim-orphan.test.ts"),
      "// Feature: spec-lantern, Property 3: orphan statement\nexport {};\n",
    );
    const result = await deriveProperties(specRoot);
    const orphan = result.properties?.find((p) => p.id === "property-3.claim-orphan");
    expect(orphan?.title).toBe("orphan statement");
    expect(orphan?.statement).toBe("orphan statement");
  });

  it("derives a single property by id", async () => {
    const result = await deriveProperty(specRoot, "property-2.claim-b");
    expect(result.issue).toBeNull();
    expect(result.property?.id).toBe("property-2.claim-b");
    expect(result.property?.statement).toBe("most recent month first");
  });

  it("returns PROPERTY_NOT_FOUND for an unknown id", async () => {
    const result = await deriveProperty(specRoot, "property-9.claim-x");
    expect(result.property).toBeNull();
    expect(result.issue?.code).toBe("PROPERTY_NOT_FOUND");
  });

  it("returns PROPERTY_TAG_MISSING when a property file has no tag", async () => {
    await writeFile(
      join(specRoot, "properties", "property-4.claim-c.test.ts"),
      "export {}; // no tag here\n",
    );
    const result = await deriveProperties(specRoot);
    expect(result.properties).toBeNull();
    expect(result.issue?.code).toBe("PROPERTY_TAG_MISSING");
  });

  it("returns CLAIMS_MISSING when claims.json is absent", async () => {
    await rm(join(specRoot, "claims.json"));
    const result = await deriveProperties(specRoot);
    expect(result.properties).toBeNull();
    expect(result.issue?.code).toBe("CLAIMS_MISSING");
  });

  it("returns PROPERTIES_DIR_MISSING when properties/ is absent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "spec-lantern-empty-"));
    try {
      const result = await deriveProperties(empty);
      expect(result.issue?.code).toBe("PROPERTIES_DIR_MISSING");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
