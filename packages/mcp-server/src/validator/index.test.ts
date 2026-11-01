// Feature: spec-lantern — artifact Validator unit/integration tests (task 6.1)
//
// Example-based coverage for the task-6.1 validation logic: Claim field checks
// (R1.3), the 1:1 Claim→Correctness_Property mapping (R3.1), and unverifiable
// Claims (R3.6). Two layers are exercised:
//
//   - validateClaims(...)         — the pure core, driven by hand-built inputs,
//                                   so each contract is asserted in isolation.
//   - validateClaimArtifacts(...) — the I/O wrapper, driven by real temp
//                                   spec-root fixtures written to disk, so the
//                                   on-disk layout (claims.json + properties/)
//                                   is exercised end-to-end.
//
// Property-based tests for the Validator are the SEPARATE optional tasks
// 6.4/6.5 and are intentionally not written here.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Claim, ObservedDeviation } from "@spec-lantern/types";
import {
  propertyTestFileName,
  propertyTag,
  claimsFilePath,
  observedDeviationsFilePath,
  ARTIFACT_PATHS,
} from "@spec-lantern/types";
import {
  validateClaims,
  validateClaimArtifacts,
  validateObservedDeviations,
  validateObservedDeviationArtifacts,
  validatePropertyTestFiles,
  validatePropertyTestFileArtifacts,
  validateSpec,
  type DiscoveredPropertyFile,
  type DiscoveredPropertyFileWithSource,
  type ValidationCode,
} from "./index.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Build a well-formed expressible Claim with overridable fields. */
function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "claim-a",
    description: "A described behavior.",
    sourceFile: "src/a.ts",
    commentRef: "L10 // does a thing",
    ...overrides,
  };
}

/** Build a discovered property file whose filename maps to `claimId`. */
function propFile(
  claimId: string,
  propertyNumber = 1,
): DiscoveredPropertyFile {
  const fileName = propertyTestFileName(propertyNumber, claimId);
  return {
    fileName,
    path: `/tmp/spec/${ARTIFACT_PATHS.propertiesDir}/${fileName}`,
    parsed: { propertyNumber, claimId },
  };
}

/** The set of codes present in a result (order-independent assertions). */
function codes(issues: { code: ValidationCode }[]): ValidationCode[] {
  return issues.map((issue) => issue.code);
}

/* -------------------------------------------------------------------------- */
/* validateClaims — pure core                                                 */
/* -------------------------------------------------------------------------- */

describe("validateClaims (task 6.1 pure core)", () => {
  it("passes a valid claims-set: one expressible Claim ↔ one property file", () => {
    const result = validateClaims([claim()], [propFile("claim-a")]);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("passes an unverifiable Claim with a reason and zero property files", () => {
    const result = validateClaims(
      [claim({ id: "claim-u", unverifiable: { reason: "fetches data internally" } })],
      [],
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects a Claim missing sourceFile", () => {
    const result = validateClaims(
      [claim({ sourceFile: "" })],
      [propFile("claim-a")],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("CLAIM_SOURCE_FILE_EMPTY");
  });

  it("rejects a Claim missing commentRef", () => {
    const result = validateClaims(
      [claim({ commentRef: "   " })],
      [propFile("claim-a")],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("CLAIM_COMMENT_REF_EMPTY");
  });

  it("rejects an expressible Claim with zero property files", () => {
    const result = validateClaims([claim()], []);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("EXPRESSIBLE_CLAIM_NO_PROPERTY");
  });

  it("rejects an expressible Claim with multiple property files", () => {
    const result = validateClaims(
      [claim()],
      [propFile("claim-a", 1), propFile("claim-a", 2)],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain(
      "EXPRESSIBLE_CLAIM_MULTIPLE_PROPERTIES",
    );
  });

  it("rejects an unverifiable Claim with an empty reason", () => {
    const result = validateClaims(
      [claim({ id: "claim-u", unverifiable: { reason: "" } })],
      [],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("UNVERIFIABLE_REASON_EMPTY");
  });

  it("rejects an unverifiable Claim that nonetheless has a property file", () => {
    const result = validateClaims(
      [claim({ id: "claim-u", unverifiable: { reason: "cannot express" } })],
      [propFile("claim-u")],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("UNVERIFIABLE_CLAIM_HAS_PROPERTY");
  });

  it("flags a dangling property file with no corresponding Claim", () => {
    const result = validateClaims([claim()], [
      propFile("claim-a"),
      propFile("claim-ghost"),
    ]);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("PROPERTY_FILE_DANGLING");
  });

  it("flags duplicate Claim ids", () => {
    const result = validateClaims(
      [claim(), claim()],
      [propFile("claim-a")],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("CLAIM_ID_DUPLICATE");
  });

  it("flags a Claim with an empty id", () => {
    const result = validateClaims([claim({ id: "" })], []);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("CLAIM_ID_EMPTY");
  });
});

/* -------------------------------------------------------------------------- */
/* validateClaimArtifacts — on-disk integration                              */
/* -------------------------------------------------------------------------- */

describe("validateClaimArtifacts (task 6.1 on-disk)", () => {
  let specRoot: string;

  beforeEach(async () => {
    specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-validator-"));
  });

  afterEach(async () => {
    await rm(specRoot, { recursive: true, force: true });
  });

  /** Write claims.json for the spec root. */
  async function writeClaims(claims: Claim[]): Promise<void> {
    await writeFile(claimsFilePath(specRoot), JSON.stringify({ claims }, null, 2));
  }

  /** Create properties/{property-n.claimId.test.ts} with a trivial body. */
  async function writePropertyFile(
    claimId: string,
    propertyNumber = 1,
  ): Promise<void> {
    const dir = join(specRoot, ARTIFACT_PATHS.propertiesDir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, propertyTestFileName(propertyNumber, claimId)),
      "// Feature: spec-lantern, Property 1: placeholder\n",
    );
  }

  it("passes a valid spec root on disk", async () => {
    await writeClaims([claim()]);
    await writePropertyFile("claim-a");
    const result = await validateClaimArtifacts(specRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("reports a missing claims.json", async () => {
    const result = await validateClaimArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("CLAIMS_FILE_MISSING");
  });

  it("reports invalid JSON in claims.json", async () => {
    await writeFile(claimsFilePath(specRoot), "{ not json ");
    const result = await validateClaimArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("CLAIMS_FILE_INVALID_JSON");
  });

  it("reports a malformed claims.json (missing claims array)", async () => {
    await writeFile(claimsFilePath(specRoot), JSON.stringify({ foo: 1 }));
    const result = await validateClaimArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("CLAIMS_FILE_MALFORMED");
  });

  it("rejects an expressible Claim whose property file is missing on disk", async () => {
    await writeClaims([claim()]);
    // No properties/ dir written at all.
    const result = await validateClaimArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("EXPRESSIBLE_CLAIM_NO_PROPERTY");
  });

  it("rejects an unverifiable Claim that has a property file on disk", async () => {
    await writeClaims([
      claim({ id: "claim-u", unverifiable: { reason: "cannot express" } }),
    ]);
    await writePropertyFile("claim-u");
    const result = await validateClaimArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("UNVERIFIABLE_CLAIM_HAS_PROPERTY");
  });

  it("validates a mixed spec root: expressible + unverifiable + property", async () => {
    await writeClaims([
      claim({ id: "claim-a" }),
      claim({ id: "claim-u", unverifiable: { reason: "fetches internally" } }),
    ]);
    await writePropertyFile("claim-a");
    const result = await validateClaimArtifacts(specRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Task 6.2 — Observed_Deviations validation                                  */
/* -------------------------------------------------------------------------- */

/** Build a well-formed concrete Observed_Deviation with overridable fields. */
function deviation(
  overrides: Partial<ObservedDeviation> = {},
): ObservedDeviation {
  return {
    id: "dev-1",
    claimId: "claim-a",
    claimedBehavior: "Months are ordered most-recent-first.",
    currentBehavior: "Months are ordered oldest-first.",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* validateObservedDeviations — pure core                                     */
/* -------------------------------------------------------------------------- */

describe("validateObservedDeviations (task 6.2 pure core)", () => {
  it("passes a valid deviations set referencing known Claims (R2.1)", () => {
    const result = validateObservedDeviations([deviation()], ["claim-a"]);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("passes the empty-list case — no difference found (R2.3)", () => {
    const result = validateObservedDeviations([], ["claim-a"]);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects a deviation referencing a non-existent Claim (R2.1/R2.2)", () => {
    const result = validateObservedDeviations(
      [deviation({ claimId: "claim-ghost" })],
      ["claim-a"],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("DEVIATION_CLAIM_ID_DANGLING");
  });

  it("rejects a deviation with an empty claimId (R2.1)", () => {
    const result = validateObservedDeviations(
      [deviation({ claimId: "" })],
      ["claim-a"],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("DEVIATION_CLAIM_ID_EMPTY");
  });

  it("rejects a deviation missing claimedBehavior (R2.1)", () => {
    const result = validateObservedDeviations(
      [deviation({ claimedBehavior: "   " })],
      ["claim-a"],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain(
      "DEVIATION_CLAIMED_BEHAVIOR_EMPTY",
    );
  });

  it("passes an undeterminable deviation: undeterminable=true + null currentBehavior (R2.4)", () => {
    const result = validateObservedDeviations(
      [
        deviation({
          id: "dev-u",
          currentBehavior: null,
          undeterminable: true,
        }),
      ],
      ["claim-a"],
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("passes a deviation with a non-null currentBehavior and no undeterminable marker (R2.1)", () => {
    const result = validateObservedDeviations(
      [deviation({ currentBehavior: "Observed oldest-first." })],
      ["claim-a"],
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects a deviation with neither current behavior nor a valid marker: null without undeterminable (R2.1/R2.4)", () => {
    const result = validateObservedDeviations(
      [deviation({ currentBehavior: null })],
      ["claim-a"],
    );
    expect(result.ok).toBe(false);
    // null currentBehavior without the marker is a marker/current disagreement.
    expect(codes(result.issues)).toContain(
      "DEVIATION_UNDETERMINABLE_MISMATCH",
    );
  });

  it("rejects a deviation with neither: empty currentBehavior and no marker (R2.1/R2.4)", () => {
    const result = validateObservedDeviations(
      [deviation({ currentBehavior: "" })],
      ["claim-a"],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain(
      "DEVIATION_MISSING_CURRENT_BEHAVIOR",
    );
  });

  it("rejects the marker/current disagreement: undeterminable=true with a non-null currentBehavior (R2.4)", () => {
    const result = validateObservedDeviations(
      [deviation({ currentBehavior: "still here", undeterminable: true })],
      ["claim-a"],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain(
      "DEVIATION_UNDETERMINABLE_MISMATCH",
    );
  });

  it("keeps all other evaluated Claims when one entry is undeterminable (R2.4)", () => {
    // An undeterminable entry must not suppress or invalidate the others: the
    // per-entry marker leaves two sibling deviations fully valid.
    const result = validateObservedDeviations(
      [
        deviation({ id: "dev-1", claimId: "claim-a" }),
        deviation({
          id: "dev-2",
          claimId: "claim-b",
          currentBehavior: null,
          undeterminable: true,
        }),
        deviation({ id: "dev-3", claimId: "claim-c" }),
      ],
      ["claim-a", "claim-b", "claim-c"],
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("flags an empty deviation id", () => {
    const result = validateObservedDeviations(
      [deviation({ id: "" })],
      ["claim-a"],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("DEVIATION_ID_EMPTY");
  });

  it("flags duplicate deviation ids", () => {
    const result = validateObservedDeviations(
      [deviation({ id: "dev-x" }), deviation({ id: "dev-x" })],
      ["claim-a"],
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("DEVIATION_ID_DUPLICATE");
  });
});

/* -------------------------------------------------------------------------- */
/* validateObservedDeviationArtifacts — on-disk integration                   */
/* -------------------------------------------------------------------------- */

describe("validateObservedDeviationArtifacts (task 6.2 on-disk)", () => {
  let specRoot: string;

  beforeEach(async () => {
    specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-deviations-"));
  });

  afterEach(async () => {
    await rm(specRoot, { recursive: true, force: true });
  });

  /** Write claims.json for the spec root. */
  async function writeClaims(claims: Claim[]): Promise<void> {
    await writeFile(
      claimsFilePath(specRoot),
      JSON.stringify({ claims }, null, 2),
    );
  }

  /** Write observed-deviations.json for the spec root. */
  async function writeDeviations(
    deviations: ObservedDeviation[],
  ): Promise<void> {
    await writeFile(
      observedDeviationsFilePath(specRoot),
      JSON.stringify({ deviations }, null, 2),
    );
  }

  /** A minimal valid Claim with the given id. */
  function claimWithId(id: string): Claim {
    return {
      id,
      description: "A described behavior.",
      sourceFile: "src/a.ts",
      commentRef: "L10 // does a thing",
    };
  }

  it("passes a valid spec root on disk", async () => {
    await writeClaims([claimWithId("claim-a")]);
    await writeDeviations([deviation()]);
    const result = await validateObservedDeviationArtifacts(specRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("passes the empty-list case on disk (R2.3)", async () => {
    await writeClaims([claimWithId("claim-a")]);
    await writeDeviations([]);
    const result = await validateObservedDeviationArtifacts(specRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("reports a missing observed-deviations.json", async () => {
    await writeClaims([claimWithId("claim-a")]);
    const result = await validateObservedDeviationArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("DEVIATIONS_FILE_MISSING");
  });

  it("reports invalid JSON in observed-deviations.json", async () => {
    await writeFile(observedDeviationsFilePath(specRoot), "{ not json ");
    const result = await validateObservedDeviationArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("DEVIATIONS_FILE_INVALID_JSON");
  });

  it("reports a malformed observed-deviations.json (missing deviations array)", async () => {
    await writeFile(
      observedDeviationsFilePath(specRoot),
      JSON.stringify({ foo: 1 }),
    );
    const result = await validateObservedDeviationArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("DEVIATIONS_FILE_MALFORMED");
  });

  it("rejects a deviation referencing a non-existent Claim on disk", async () => {
    await writeClaims([claimWithId("claim-a")]);
    await writeDeviations([deviation({ claimId: "claim-ghost" })]);
    const result = await validateObservedDeviationArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("DEVIATION_CLAIM_ID_DANGLING");
  });

  it("validates an undeterminable entry alongside valid entries on disk (R2.4)", async () => {
    await writeClaims([
      claimWithId("claim-a"),
      claimWithId("claim-b"),
    ]);
    await writeDeviations([
      deviation({ id: "dev-1", claimId: "claim-a" }),
      deviation({
        id: "dev-2",
        claimId: "claim-b",
        currentBehavior: null,
        undeterminable: true,
      }),
    ]);
    const result = await validateObservedDeviationArtifacts(specRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Task 6.3 — property-test-file runnability (static, host-safe)              */
/* -------------------------------------------------------------------------- */

/**
 * Build a well-formed property test file body: the exact tag for property `n`,
 * a Vitest `test(` entry point, and an `expect(` assertion. Overridable so
 * individual checks can omit one ingredient at a time.
 */
function wellFormedPropertySource(
  propertyNumber = 1,
  opts: {
    tag?: string | null;
    entryPoint?: boolean;
    assertion?: boolean;
  } = {},
): string {
  const lines: string[] = [];
  const tag =
    opts.tag === undefined
      ? propertyTag(propertyNumber, "most recent month first")
      : opts.tag;
  if (tag !== null) lines.push(`// ${tag}`);
  lines.push(`import { test, expect } from "vitest";`);
  if (opts.entryPoint !== false) {
    lines.push(`test("does the thing", () => {`);
    if (opts.assertion !== false) lines.push(`  expect(1 + 1).toBe(2);`);
    lines.push(`});`);
  } else if (opts.assertion !== false) {
    // Assertion present but no test() wrapper (entry point omitted).
    lines.push(`expect(1 + 1).toBe(2);`);
  }
  return lines.join("\n") + "\n";
}

/** Build a `{ file, source }` pair whose filename maps to `claimId`. */
function propFileWithSource(
  claimId: string,
  propertyNumber: number,
  source: string,
): DiscoveredPropertyFileWithSource {
  const fileName = propertyTestFileName(propertyNumber, claimId);
  return {
    file: {
      fileName,
      path: `/tmp/spec/${ARTIFACT_PATHS.propertiesDir}/${fileName}`,
      parsed: { propertyNumber, claimId },
    },
    source,
  };
}

describe("validatePropertyTestFiles (task 6.3 pure core)", () => {
  it("passes a well-formed property file: correct name, tag, test() + expect()", () => {
    const result = validatePropertyTestFiles([
      propFileWithSource("claim-a", 1, wellFormedPropertySource(1)),
    ]);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("passes a fast-check property file (fc.assert / fc.property as the assertion)", () => {
    const source = [
      `// ${propertyTag(2, "ordering holds for all inputs")}`,
      `import { test } from "vitest";`,
      `import fc from "fast-check";`,
      `test("holds", () => {`,
      `  fc.assert(fc.property(fc.integer(), (n) => n === n), { numRuns: 100 });`,
      `});`,
    ].join("\n");
    const result = validatePropertyTestFiles([
      propFileWithSource("claim-b", 2, source),
    ]);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects a file with a missing tag", () => {
    const result = validatePropertyTestFiles([
      propFileWithSource(
        "claim-a",
        1,
        wellFormedPropertySource(1, { tag: null }),
      ),
    ]);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("PROPERTY_FILE_TAG_MISSING");
  });

  it("rejects a file whose tag number disagrees with its filename number", () => {
    // Filename says property 1, tag says property 7.
    const result = validatePropertyTestFiles([
      propFileWithSource(
        "claim-a",
        1,
        wellFormedPropertySource(7),
      ),
    ]);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain(
      "PROPERTY_FILE_TAG_NUMBER_MISMATCH",
    );
  });

  it("rejects a file with no test entry point", () => {
    const result = validatePropertyTestFiles([
      propFileWithSource(
        "claim-a",
        1,
        wellFormedPropertySource(1, { entryPoint: false }),
      ),
    ]);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain(
      "PROPERTY_FILE_NO_TEST_ENTRY_POINT",
    );
  });

  it("rejects a file with no assertion", () => {
    const result = validatePropertyTestFiles([
      propFileWithSource(
        "claim-a",
        1,
        wellFormedPropertySource(1, { assertion: false }),
      ),
    ]);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("PROPERTY_FILE_NO_ASSERTION");
  });

  it("rejects an empty file", () => {
    const result = validatePropertyTestFiles([
      propFileWithSource("claim-a", 1, "   \n  "),
    ]);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("PROPERTY_FILE_EMPTY");
  });

  it("flags a non-convention filename under properties/", () => {
    const result = validatePropertyTestFiles([
      {
        file: {
          fileName: "not-a-property.test.ts",
          path: `/tmp/spec/${ARTIFACT_PATHS.propertiesDir}/not-a-property.test.ts`,
          parsed: null,
        },
        source: wellFormedPropertySource(1),
      },
    ]);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain(
      "PROPERTY_FILE_NAME_NON_CONVENTION",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* validatePropertyTestFileArtifacts — on-disk integration                    */
/* -------------------------------------------------------------------------- */

describe("validatePropertyTestFileArtifacts (task 6.3 on-disk)", () => {
  let specRoot: string;

  beforeEach(async () => {
    specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-propfiles-"));
  });

  afterEach(async () => {
    await rm(specRoot, { recursive: true, force: true });
  });

  /** Write a file (with any basename) into the spec's properties/ directory. */
  async function writeProp(fileName: string, source: string): Promise<void> {
    const dir = join(specRoot, ARTIFACT_PATHS.propertiesDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), source);
  }

  it("passes a well-formed property file on disk", async () => {
    await writeProp(
      propertyTestFileName(1, "claim-a"),
      wellFormedPropertySource(1),
    );
    const result = await validatePropertyTestFileArtifacts(specRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("treats a missing properties/ directory as zero files (no issues)", async () => {
    const result = await validatePropertyTestFileArtifacts(specRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects an empty property file on disk", async () => {
    await writeProp(propertyTestFileName(1, "claim-a"), "");
    const result = await validatePropertyTestFileArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("PROPERTY_FILE_EMPTY");
  });

  it("rejects a property file missing its tag on disk", async () => {
    await writeProp(
      propertyTestFileName(1, "claim-a"),
      wellFormedPropertySource(1, { tag: null }),
    );
    const result = await validatePropertyTestFileArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain("PROPERTY_FILE_TAG_MISSING");
  });

  it("flags a non-convention filename under properties/ on disk", async () => {
    await writeProp("stray.test.ts", wellFormedPropertySource(1));
    const result = await validatePropertyTestFileArtifacts(specRoot);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain(
      "PROPERTY_FILE_NAME_NON_CONVENTION",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* validateSpec — full composition across 6.1 + 6.2 + 6.3                     */
/* -------------------------------------------------------------------------- */

describe("validateSpec (6.1 + 6.2 + 6.3 composition)", () => {
  let specRoot: string;

  beforeEach(async () => {
    specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-spec-"));
  });

  afterEach(async () => {
    await rm(specRoot, { recursive: true, force: true });
  });

  it("passes a fully valid spec root across claims + deviations + property files", async () => {
    await writeFile(
      claimsFilePath(specRoot),
      JSON.stringify(
        {
          claims: [
            {
              id: "claim-a",
              description: "A described behavior.",
              sourceFile: "src/a.ts",
              commentRef: "L10 // does a thing",
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      observedDeviationsFilePath(specRoot),
      JSON.stringify({ deviations: [] }, null, 2),
    );
    const dir = join(specRoot, ARTIFACT_PATHS.propertiesDir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, propertyTestFileName(1, "claim-a")),
      wellFormedPropertySource(1),
    );

    const result = await validateSpec(specRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
