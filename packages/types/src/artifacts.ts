/**
 * @spec-lantern/types — on-disk artifact schemas and conventions.
 *
 * This module defines the CONCRETE, PERSISTED formats that Kiro writes at
 * authoring time and that downstream tooling (the Validator, task 6; the
 * prediction-lock tool, task 7) reads back from disk. It is distinct from the
 * in-memory domain types in `./index.ts`:
 *
 *  - `./index.ts` describes the shapes that flow through the running pipeline
 *    (across the MCP boundary, into the UI).
 *  - this module describes how a subset of those shapes is *serialized to disk*
 *    as spec artifacts, plus the directory layout that links them together and
 *    the executable property-test-file convention that Kiro must follow.
 *
 * Everything here is dependency-light: JSON Schema documents are declared as
 * typed constants (JSON Schema draft 2020-12, the vocabulary most validators
 * accept), and the on-disk layout is expressed as typed path-builder helpers
 * and machine-checkable patterns. No schema library is introduced; a validator
 * may feed these constants to whichever JSON Schema engine it prefers.
 *
 * Requirements traceability: 1.1, 1.2, 1.3, 2.1, 3.1, 3.4, 3.6, 4.1, 4.4.
 */

/**
 * A minimal structural type for the JSON Schema documents declared below.
 *
 * We deliberately keep this loose (`Record<string, unknown>`-ish) rather than
 * pulling in a full JSON Schema type package: the goal is to ship validatable
 * schema *documents*, not to type-check the JSON Schema meta-schema itself.
 */
export interface JsonSchemaDocument {
  $schema: string;
  $id: string;
  title: string;
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  [keyword: string]: unknown;
}

/** JSON Schema dialect used by every artifact schema in this module. */
export const JSON_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema" as const;

/** Stable `$id` base so schemas can `$ref` one another and be addressed by tools. */
export const SCHEMA_ID_BASE = "https://spec-lantern.dev/schemas" as const;

/* -------------------------------------------------------------------------- */
/* Claims (R1.3, R3.6)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * On-disk schema for a single Claim.
 *
 * R1.3: every Claim carries a non-empty `sourceFile` and a non-empty
 * `commentRef` identifying where the claimed behavior was derived from.
 * R3.6: a Claim that cannot be expressed as an executable Correctness_Property
 * is marked `unverifiable` with a non-empty `reason`.
 */
export const CLAIM_SCHEMA: JsonSchemaDocument = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: `${SCHEMA_ID_BASE}/claim.schema.json`,
  title: "Claim",
  type: "object",
  additionalProperties: false,
  required: ["id", "description", "sourceFile", "commentRef"],
  properties: {
    id: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    // R1.3: non-empty origin references.
    sourceFile: { type: "string", minLength: 1 },
    commentRef: { type: "string", minLength: 1 },
    // R3.6: optional; when present it must carry a non-empty reason.
    unverifiable: {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: {
        reason: { type: "string", minLength: 1 },
      },
    },
  },
};

/** On-disk schema for the full Claims collection written per spec. */
export const CLAIMS_FILE_SCHEMA: JsonSchemaDocument = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: `${SCHEMA_ID_BASE}/claims.schema.json`,
  title: "Claims",
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: { $ref: `${SCHEMA_ID_BASE}/claim.schema.json` },
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Observed_Deviations (R2.1–R2.4)                                            */
/* -------------------------------------------------------------------------- */

/**
 * On-disk schema for a single Observed_Deviation.
 *
 * R2.1/R2.2: each entry references its originating Claim via `claimId` and
 * records the claimed behavior.
 * R2.4: when current behavior cannot be determined, `undeterminable` is `true`
 * and `currentBehavior` is `null`; otherwise `currentBehavior` is a non-empty
 * description. The `undeterminable` marker and the `null` current behavior
 * travel together.
 */
export const OBSERVED_DEVIATION_SCHEMA: JsonSchemaDocument = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: `${SCHEMA_ID_BASE}/observed-deviation.schema.json`,
  title: "ObservedDeviation",
  type: "object",
  additionalProperties: false,
  required: ["id", "claimId", "claimedBehavior", "currentBehavior"],
  properties: {
    id: { type: "string", minLength: 1 },
    // R2.1/R2.2: reference to the originating Claim.
    claimId: { type: "string", minLength: 1 },
    claimedBehavior: { type: "string", minLength: 1 },
    // R2.4: null only when the behavior could not be determined.
    currentBehavior: {
      oneOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
    // R2.4: undeterminable marker.
    undeterminable: { type: "boolean" },
  },
  // R2.4: the undeterminable marker and a null currentBehavior must agree.
  allOf: [
    {
      // If undeterminable === true then currentBehavior must be null.
      if: {
        properties: { undeterminable: { const: true } },
        required: ["undeterminable"],
      },
      then: { properties: { currentBehavior: { type: "null" } } },
    },
    {
      // If currentBehavior is null then undeterminable must be true.
      if: { properties: { currentBehavior: { type: "null" } } },
      then: {
        properties: { undeterminable: { const: true } },
        required: ["undeterminable"],
      },
    },
  ],
};

/**
 * On-disk schema for the full Observed_Deviations collection.
 *
 * R2.3: the empty-list case is explicitly valid — when no difference is found
 * across all evaluated Claims the array simply contains zero entries
 * (`minItems` is 0).
 */
export const OBSERVED_DEVIATIONS_FILE_SCHEMA: JsonSchemaDocument = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: `${SCHEMA_ID_BASE}/observed-deviations.schema.json`,
  title: "ObservedDeviations",
  type: "object",
  additionalProperties: false,
  required: ["deviations"],
  properties: {
    deviations: {
      type: "array",
      // R2.3: zero deviations is a valid, meaningful result.
      minItems: 0,
      items: { $ref: `${SCHEMA_ID_BASE}/observed-deviation.schema.json` },
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Predicted_Results (R3.4)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * On-disk schema for a single Predicted_Result.
 *
 * R3.4: a Predicted_Result is a verdict (exactly one of PASS/FAIL) recorded
 * BEFORE execution. The `recordedAt` ISO-8601 timestamp evidences that the
 * prediction predates execution; `immutable` is pinned to `true` so the
 * serialized record carries the immutability contract (R3.5) on its face.
 * `propertyId` ties the prediction to the Correctness_Property it predicts.
 */
export const PREDICTED_RESULT_SCHEMA: JsonSchemaDocument = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: `${SCHEMA_ID_BASE}/predicted-result.schema.json`,
  title: "PredictedResult",
  type: "object",
  additionalProperties: false,
  required: ["propertyId", "verdict", "recordedAt", "immutable"],
  properties: {
    propertyId: { type: "string", minLength: 1 },
    // Closed verdict enum — never a timeout/error outcome.
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    // Pre-execution timestamp (R3.4).
    recordedAt: { type: "string", format: "date-time", minLength: 1 },
    // R3.5: immutability contract pinned on disk.
    immutable: { const: true },
  },
};

/* -------------------------------------------------------------------------- */
/* Prediction locks (R3.4, R3.5)                                              */
/* -------------------------------------------------------------------------- */

/**
 * On-disk schema for a single Prediction_Lock.
 *
 * R3.4/R3.5: once execution of a Correctness_Property begins, its
 * Predicted_Result is immutable and any later comparison (task 14) must read
 * the ORIGINALLY recorded value. A lock makes that tamper-evident on disk: it
 * captures the exact Predicted_Result verdict together with a `contentHash`
 * computed over the serialized Predicted_Result AND the bytes of the
 * Correctness_Property test file it refers to, plus a `lockedAt` timestamp. If
 * either the prediction or the property artifact is edited after the lock is
 * written, recomputing the hash no longer matches the stored `contentHash`, so
 * the drift is detectable and the comparison can keep using the locked verdict.
 *
 * `hashAlgorithm` is pinned so a reader hashes with the same algorithm the
 * writer used; `verdict` is duplicated out of the hashed prediction so a reader
 * has the originally recorded value directly, without re-reading (and
 * re-trusting) the prediction file.
 */
export const PREDICTION_LOCK_SCHEMA: JsonSchemaDocument = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: `${SCHEMA_ID_BASE}/prediction-lock.schema.json`,
  title: "PredictionLock",
  type: "object",
  additionalProperties: false,
  required: [
    "propertyId",
    "verdict",
    "hashAlgorithm",
    "contentHash",
    "lockedAt",
  ],
  properties: {
    // Ties the lock to the property it locks (matches the Predicted_Result).
    propertyId: { type: "string", minLength: 1 },
    // The originally recorded verdict, surfaced for direct reads by task 14.
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    // Pinned so a reader hashes with the same algorithm the writer used.
    hashAlgorithm: { type: "string", const: "sha256" },
    // Hex digest over (serialized Predicted_Result + Correctness_Property bytes).
    contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    // When the lock was written (execution-start boundary).
    lockedAt: { type: "string", format: "date-time", minLength: 1 },
  },
};

/** The hashing algorithm every Prediction_Lock uses. */
export const PREDICTION_LOCK_HASH_ALGORITHM = "sha256" as const;

/* -------------------------------------------------------------------------- */
/* Correctness_Property executable test-file convention (R3.1, R4.1, R4.4)    */
/* -------------------------------------------------------------------------- */

/**
 * The executable property-test-file convention.
 *
 * R3.1: each expressible Claim is converted into exactly ONE Correctness_Property,
 * authored as exactly one executable test file (1:1 Claim <-> property <-> file).
 * R4.4/R4.1: component-rendered properties are authored the same way — one file,
 * same tag format — targeting the rendered output of a props-driven component.
 *
 * The contract a property test file MUST satisfy:
 *  1. NAMING   — `property-{n}.{claimId}.test.ts`, where `{n}` is the property
 *                number and `{claimId}` is the id of the Claim it verifies. The
 *                `{n}` lets a file be tied to its tag; the `{claimId}` makes the
 *                1:1 Claim->file mapping discoverable from the filename alone.
 *  2. LOCATION — under the spec's `properties/` directory (see the layout
 *                helpers below), one file per property, no more, no less.
 *  3. TAG      — the file contains a comment of the exact form
 *                `Feature: spec-lantern, Property {n}: {property_text}` so a
 *                tool can match the file to the property it implements.
 *  4. TERMINATION — the test terminates with exactly ONE of PASS or FAIL. A run
 *                that neither passes nor fails (e.g. it throws before asserting,
 *                or never terminates) violates the convention; timeouts/errors
 *                are surfaced by the runner as distinct outcomes, never folded
 *                into PASS/FAIL (see `ActualResult` in ./index.ts).
 */

/** Numeric property-number stamped into both the filename and the tag. */
export type PropertyNumber = number;

/**
 * Glob matching every Correctness_Property test file within a spec's
 * `properties/` directory. Consumers can expand this to enumerate the files.
 */
export const PROPERTY_TEST_FILE_GLOB = "properties/property-*.test.ts" as const;

/**
 * Regex matching a Correctness_Property test *filename* (basename only) and
 * capturing the property number (`n`) and the `claimId`.
 *
 * Matches e.g. `property-3.claim-monthly-order.test.ts` capturing `3` and
 * `claim-monthly-order`. `claimId` may contain any non-dot characters so ids
 * with dashes/underscores work; the `.test.ts` suffix is required.
 */
export const PROPERTY_TEST_FILENAME_REGEX =
  /^property-(\d+)\.([^.]+)\.test\.ts$/;

/**
 * Regex matching the in-file tag comment and capturing the property number and
 * the property text. The tag text is matched case-sensitively and tolerant of
 * leading comment markers / whitespace on the line.
 *
 * Matches e.g. `// Feature: spec-lantern, Property 3: most recent month first`
 * capturing `3` and `most recent month first`.
 */
export const PROPERTY_TAG_REGEX =
  /Feature: spec-lantern, Property (\d+):\s*(.+?)\s*$/m;

/** Build the canonical property-test-file basename for a property. */
export function propertyTestFileName(
  propertyNumber: PropertyNumber,
  claimId: string,
): string {
  if (!Number.isInteger(propertyNumber) || propertyNumber < 1) {
    throw new Error(
      `propertyNumber must be a positive integer, got ${String(propertyNumber)}`,
    );
  }
  if (claimId.length === 0 || claimId.includes(".")) {
    throw new Error(
      `claimId must be non-empty and contain no '.' characters, got "${claimId}"`,
    );
  }
  return `property-${propertyNumber}.${claimId}.test.ts`;
}

/** Build the exact tag comment line a property test file must contain. */
export function propertyTag(
  propertyNumber: PropertyNumber,
  propertyText: string,
): string {
  return `Feature: spec-lantern, Property ${propertyNumber}: ${propertyText}`;
}

/** Parsed view of a property-test filename. */
export interface ParsedPropertyTestFileName {
  propertyNumber: number;
  claimId: string;
}

/**
 * Parse a property-test filename (basename) into its parts, or `null` if it
 * does not follow the convention. Lets the Validator discover the Claim a file
 * belongs to directly from its name.
 */
export function parsePropertyTestFileName(
  fileName: string,
): ParsedPropertyTestFileName | null {
  const match = PROPERTY_TEST_FILENAME_REGEX.exec(fileName);
  if (!match) return null;
  return { propertyNumber: Number(match[1]), claimId: match[2] };
}

/** Parsed view of the in-file property tag. */
export interface ParsedPropertyTag {
  propertyNumber: number;
  propertyText: string;
}

/**
 * Extract the `Feature: spec-lantern, Property {n}: {text}` tag from a test
 * file's source, or `null` if the required tag is absent.
 */
export function parsePropertyTag(source: string): ParsedPropertyTag | null {
  const match = PROPERTY_TAG_REGEX.exec(source);
  if (!match) return null;
  return { propertyNumber: Number(match[1]), propertyText: match[2] };
}

/* -------------------------------------------------------------------------- */
/* On-disk layout (R3.1 1:1 mapping, discoverable)                            */
/* -------------------------------------------------------------------------- */

/**
 * Canonical on-disk layout for a spec-lantern spec. Every artifact has one
 * well-known home so the Claim -> Correctness_Property test file ->
 * Predicted_Result linkage is resolvable purely from paths.
 *
 * Given a spec root directory:
 *
 *   {specRoot}/
 *     claims.json                                  // CLAIMS_FILE_SCHEMA
 *     observed-deviations.json                     // OBSERVED_DEVIATIONS_FILE_SCHEMA
 *     properties/
 *       property-{n}.{claimId}.test.ts             // one per expressible Claim
 *     predictions/
 *       property-{n}.{claimId}.predicted.json      // PREDICTED_RESULT_SCHEMA, one per property
 *     locks/
 *       property-{n}.{claimId}.lock.json           // PREDICTION_LOCK_SCHEMA, one per locked property
 *
 * The 1:1 mapping is expressible AND discoverable: for a given Claim `c`, its
 * property test file, its prediction file, and its lock file all share the same
 * `{n}.{claimId}` stem, so a tool can walk from `claims.json` to the property
 * file to the prediction to the lock without any separate index.
 */
export const ARTIFACT_PATHS = {
  claimsFile: "claims.json",
  observedDeviationsFile: "observed-deviations.json",
  propertiesDir: "properties",
  predictionsDir: "predictions",
  locksDir: "locks",
} as const;

/** Join path segments with `/` (POSIX), the on-disk layout's canonical separator. */
function joinPosix(...segments: string[]): string {
  return segments
    .map((s, i) => (i === 0 ? s.replace(/\/+$/, "") : s.replace(/^\/+|\/+$/g, "")))
    .filter((s) => s.length > 0)
    .join("/");
}

/** Absolute/relative path to the Claims file for a spec root. */
export function claimsFilePath(specRoot: string): string {
  return joinPosix(specRoot, ARTIFACT_PATHS.claimsFile);
}

/** Path to the Observed_Deviations file for a spec root. */
export function observedDeviationsFilePath(specRoot: string): string {
  return joinPosix(specRoot, ARTIFACT_PATHS.observedDeviationsFile);
}

/** Path to a Claim's Correctness_Property test file. */
export function propertyTestFilePath(
  specRoot: string,
  propertyNumber: PropertyNumber,
  claimId: string,
): string {
  return joinPosix(
    specRoot,
    ARTIFACT_PATHS.propertiesDir,
    propertyTestFileName(propertyNumber, claimId),
  );
}

/** Canonical basename for a property's Predicted_Result file. */
export function predictedResultFileName(
  propertyNumber: PropertyNumber,
  claimId: string,
): string {
  if (!Number.isInteger(propertyNumber) || propertyNumber < 1) {
    throw new Error(
      `propertyNumber must be a positive integer, got ${String(propertyNumber)}`,
    );
  }
  if (claimId.length === 0 || claimId.includes(".")) {
    throw new Error(
      `claimId must be non-empty and contain no '.' characters, got "${claimId}"`,
    );
  }
  return `property-${propertyNumber}.${claimId}.predicted.json`;
}

/** Path to a property's Predicted_Result file. */
export function predictedResultFilePath(
  specRoot: string,
  propertyNumber: PropertyNumber,
  claimId: string,
): string {
  return joinPosix(
    specRoot,
    ARTIFACT_PATHS.predictionsDir,
    predictedResultFileName(propertyNumber, claimId),
  );
}

/** Canonical basename for a property's Prediction_Lock file. */
export function predictionLockFileName(
  propertyNumber: PropertyNumber,
  claimId: string,
): string {
  if (!Number.isInteger(propertyNumber) || propertyNumber < 1) {
    throw new Error(
      `propertyNumber must be a positive integer, got ${String(propertyNumber)}`,
    );
  }
  if (claimId.length === 0 || claimId.includes(".")) {
    throw new Error(
      `claimId must be non-empty and contain no '.' characters, got "${claimId}"`,
    );
  }
  return `property-${propertyNumber}.${claimId}.lock.json`;
}

/** Path to a property's Prediction_Lock file. */
export function predictionLockFilePath(
  specRoot: string,
  propertyNumber: PropertyNumber,
  claimId: string,
): string {
  return joinPosix(
    specRoot,
    ARTIFACT_PATHS.locksDir,
    predictionLockFileName(propertyNumber, claimId),
  );
}

/**
 * The discoverable 1:1 linkage for a single Claim: its property test file and
 * its prediction file, both derivable from the Claim id + property number. A
 * Validator can build this for every expressible Claim and assert exactly one
 * property file and one prediction file exist per Claim (R3.1).
 */
export interface ClaimArtifactLinkage {
  claimId: string;
  propertyNumber: PropertyNumber;
  propertyTestFile: string;
  predictedResultFile: string;
  /** Where the property's Prediction_Lock is written/read (R3.4, R3.5). */
  predictionLockFile: string;
}

/** Resolve the on-disk linkage for a Claim under a spec root. */
export function resolveClaimLinkage(
  specRoot: string,
  claimId: string,
  propertyNumber: PropertyNumber,
): ClaimArtifactLinkage {
  return {
    claimId,
    propertyNumber,
    propertyTestFile: propertyTestFilePath(specRoot, propertyNumber, claimId),
    predictedResultFile: predictedResultFilePath(
      specRoot,
      propertyNumber,
      claimId,
    ),
    predictionLockFile: predictionLockFilePath(
      specRoot,
      propertyNumber,
      claimId,
    ),
  };
}

/** Convenience bundle of all artifact schemas, keyed by artifact kind. */
export const ARTIFACT_SCHEMAS = {
  claim: CLAIM_SCHEMA,
  claims: CLAIMS_FILE_SCHEMA,
  observedDeviation: OBSERVED_DEVIATION_SCHEMA,
  observedDeviations: OBSERVED_DEVIATIONS_FILE_SCHEMA,
  predictedResult: PREDICTED_RESULT_SCHEMA,
  predictionLock: PREDICTION_LOCK_SCHEMA,
} as const;
