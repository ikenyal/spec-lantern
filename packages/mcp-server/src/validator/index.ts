/**
 * @spec-lantern/mcp-server — the artifact Validator.
 *
 * The Validator reads the on-disk spec-lantern artifacts a Kiro authoring run
 * produces (see `@spec-lantern/types` `./artifacts.ts` for the persisted
 * formats and the canonical directory layout) and reports, as STRUCTURED DATA,
 * whether they honor the contracts the pipeline relies on. It is consumed
 * alongside the prediction-lock tool (task 7) and by downstream report/UI
 * tooling, so it NEVER throws on a malformed artifact: a missing file, invalid
 * JSON, a dangling reference, or a broken 1:1 mapping all surface as
 * {@link ValidationIssue}s on a {@link ValidationResult}, exactly like a
 * well-formed-but-invalid artifact would. Only genuinely unexpected host
 * failures (e.g. a permission error reading a directory that exists) propagate.
 *
 * This module is built to be EXTENDED. Task 6.1 validates Claims, the 1:1
 * Claim→Correctness_Property mapping, and unverifiable Claims. Task 6.2
 * validates Observed_Deviations. Task 6.3 validates that each property test
 * file is runnable and shaped to terminate PASS/FAIL. All three live in the
 * SAME module: they contribute additional `validate*` functions and additional
 * {@link ValidationCode}s, and `validateSpec()` composes them. The shared
 * vocabulary — `ValidationIssue`, `ValidationResult`, `combineResults()` — is
 * the seam they plug into.
 *
 * Design discipline mirrored from `./index.ts`'s `ActualResult`: outcomes are a
 * CLOSED union. A {@link ValidationCode} enumerates every way an artifact can be
 * wrong; a caller can exhaustively `switch` on it. "ok" is derived, never
 * independently asserted: a result is ok iff it carries zero `error`-severity
 * issues.
 *
 * Requirements traceability: 1.3, 3.1, 3.6 (task 6.1); 2.1–2.4 (task 6.2);
 * 3.2 (task 6.3).
 */
import { readFile, readdir } from "node:fs/promises";
import type { Claim, ObservedDeviation } from "@spec-lantern/types";
import {
  claimsFilePath,
  observedDeviationsFilePath,
  parsePropertyTestFileName,
  parsePropertyTag,
  ARTIFACT_PATHS,
  type ParsedPropertyTestFileName,
} from "@spec-lantern/types";

/* -------------------------------------------------------------------------- */
/* Shared validation vocabulary (extended by 6.2 / 6.3)                       */
/* -------------------------------------------------------------------------- */

/**
 * Severity of a validation issue.
 *
 *  - `error`   — the artifact violates a contract the pipeline requires; the
 *                overall result is NOT ok. (Every 6.1 finding is an error.)
 *  - `warning` — advisory; does not by itself make the result not-ok. Reserved
 *                for later checks that want to surface non-fatal observations.
 */
export type ValidationSeverity = "error" | "warning";

/**
 * Closed enumeration of every validation finding this module can produce.
 *
 * Grouped by scope. Task 6.1 owns the Claim-mapping codes below. Tasks 6.2/6.3
 * extend this union with their own codes (e.g. deviation-reference and
 * property-termination findings); keeping them in one place lets a caller
 * exhaustively handle every artifact problem the Validator knows about.
 */
export type ValidationCode =
  /** The `claims.json` file is missing at the expected path. */
  | "CLAIMS_FILE_MISSING"
  /** `claims.json` exists but is not parseable JSON. */
  | "CLAIMS_FILE_INVALID_JSON"
  /** `claims.json` parsed but is not `{ claims: Claim[] }`. */
  | "CLAIMS_FILE_MALFORMED"
  /** A Claim has an empty/missing `id`. */
  | "CLAIM_ID_EMPTY"
  /** Two or more Claims share the same `id`. */
  | "CLAIM_ID_DUPLICATE"
  /** R1.3: a Claim has an empty/missing `sourceFile`. */
  | "CLAIM_SOURCE_FILE_EMPTY"
  /** R1.3: a Claim has an empty/missing `commentRef`. */
  | "CLAIM_COMMENT_REF_EMPTY"
  /** R3.6: an unverifiable Claim's `reason` is empty/missing. */
  | "UNVERIFIABLE_REASON_EMPTY"
  /** R3.6: an unverifiable Claim nonetheless has a property test file. */
  | "UNVERIFIABLE_CLAIM_HAS_PROPERTY"
  /** R3.1: an expressible Claim has zero property test files. */
  | "EXPRESSIBLE_CLAIM_NO_PROPERTY"
  /** R3.1: an expressible Claim has more than one property test file. */
  | "EXPRESSIBLE_CLAIM_MULTIPLE_PROPERTIES"
  /** A property test file's `claimId` matches no Claim (dangling). */
  | "PROPERTY_FILE_DANGLING"
  /* -- task 6.2: Observed_Deviation codes (R2.1–R2.4) ---------------------- */
  /** The `observed-deviations.json` file is missing at the expected path. */
  | "DEVIATIONS_FILE_MISSING"
  /** `observed-deviations.json` exists but is not parseable JSON. */
  | "DEVIATIONS_FILE_INVALID_JSON"
  /** `observed-deviations.json` parsed but is not `{ deviations: [] }`. */
  | "DEVIATIONS_FILE_MALFORMED"
  /** An Observed_Deviation has an empty/missing `id`. */
  | "DEVIATION_ID_EMPTY"
  /** Two or more Observed_Deviations share the same `id`. */
  | "DEVIATION_ID_DUPLICATE"
  /** R2.1: an Observed_Deviation has an empty/missing `claimId`. */
  | "DEVIATION_CLAIM_ID_EMPTY"
  /** R2.1/R2.2: a deviation's `claimId` matches no Claim (dangling). */
  | "DEVIATION_CLAIM_ID_DANGLING"
  /** R2.1: an Observed_Deviation has an empty/missing `claimedBehavior`. */
  | "DEVIATION_CLAIMED_BEHAVIOR_EMPTY"
  /**
   * R2.1/R2.4: an Observed_Deviation carries neither a non-empty
   * `currentBehavior` nor a valid undeterminable marker (null `currentBehavior`
   * with `undeterminable === true`).
   */
  | "DEVIATION_MISSING_CURRENT_BEHAVIOR"
  /**
   * R2.4: the `undeterminable` marker and a `null` `currentBehavior` disagree —
   * one is set without the other.
   */
  | "DEVIATION_UNDETERMINABLE_MISMATCH"
  /* -- task 6.3: property-test-file runnability codes (R3.2) -------------- */
  /**
   * R3.2: a file under `properties/` does not follow the
   * `property-{n}.{claimId}.test.ts` naming convention, so it cannot be tied to
   * a Claim or its tag and is not a recognizable Correctness_Property artifact.
   */
  | "PROPERTY_FILE_NAME_NON_CONVENTION"
  /**
   * R3.2: a property test file is empty (or whitespace-only), so it carries no
   * test and can never terminate in a PASS/FAIL verdict.
   */
  | "PROPERTY_FILE_EMPTY"
  /**
   * R3.2: a property test file is missing the required in-file tag comment
   * `Feature: spec-lantern, Property {n}: {text}`.
   */
  | "PROPERTY_FILE_TAG_MISSING"
  /**
   * R3.2: the property number in the file's tag disagrees with the property
   * number in its filename, so the file and tag describe different properties.
   */
  | "PROPERTY_FILE_TAG_NUMBER_MISMATCH"
  /**
   * R3.2: a property test file contains no Vitest entry point
   * (`test(`/`it(`/`describe(`), so there is nothing for the runner to invoke
   * and no path to a PASS/FAIL verdict.
   */
  | "PROPERTY_FILE_NO_TEST_ENTRY_POINT"
  /**
   * R3.2: a property test file contains no assertion / termination signal
   * (`expect(`, `assert`, or a fast-check `fc.assert`/`fc.property`), so it has
   * no way to produce a FAIL and would always trivially pass — the artifact is
   * not shaped to yield a real PASS/FAIL verdict.
   */
  | "PROPERTY_FILE_NO_ASSERTION";

/** A single structured validation finding. */
export interface ValidationIssue {
  /** Advisory vs fatal (see {@link ValidationSeverity}). */
  severity: ValidationSeverity;
  /** The closed-union code; a caller can switch on it. */
  code: ValidationCode;
  /** Human-readable, self-contained explanation of the finding. */
  message: string;
  /** The Claim this issue concerns, when applicable. */
  claimId?: string;
  /** The artifact file path this issue concerns, when applicable. */
  path?: string;
}

/**
 * The structured outcome of a validation pass. `ok` is DERIVED: it is `true`
 * exactly when `issues` contains no `error`-severity entry. Callers should rely
 * on `ok` rather than re-deriving it, but either is equivalent.
 */
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** Build a {@link ValidationResult}, deriving `ok` from the issue severities. */
export function makeResult(issues: ValidationIssue[]): ValidationResult {
  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

/**
 * Merge several results into one, concatenating issues and re-deriving `ok`.
 * This is the composition seam `validateSpec()` uses to fold 6.1/6.2/6.3
 * together.
 */
export function combineResults(
  ...results: ValidationResult[]
): ValidationResult {
  return makeResult(results.flatMap((result) => result.issues));
}

/* -------------------------------------------------------------------------- */
/* Loading Claims from disk (no throw — malformed input becomes issues)       */
/* -------------------------------------------------------------------------- */

/**
 * The result of attempting to load `claims.json`: either the parsed Claims, or
 * the issue explaining why they could not be loaded. Exactly one of `claims` /
 * `loadIssue` is set.
 */
interface LoadedClaims {
  claims: Claim[] | null;
  loadIssue: ValidationIssue | null;
}

/** Narrow an unknown parsed value to a `{ claims: unknown[] }` envelope. */
function isClaimsEnvelope(value: unknown): value is { claims: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { claims?: unknown }).claims)
  );
}

/** True for a non-empty string (the R1.3/R3.6 "non-empty" predicate). */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Load and shallow-parse the Claims file for a spec root WITHOUT throwing on
 * bad input. A missing file, invalid JSON, or a non-`{ claims: [] }` shape each
 * come back as a `loadIssue` so the caller can report them structurally.
 *
 * Note: this does not validate individual Claims (that is
 * {@link validateClaims}'s job) — it only guarantees that, on success, `claims`
 * is an array whose elements are `object`s to be field-checked downstream.
 */
async function loadClaims(specRoot: string): Promise<LoadedClaims> {
  const path = claimsFilePath(specRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // ENOENT is the expected "artifact not authored" case; anything else
    // (e.g. EACCES) is an unexpected host failure and should propagate.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        claims: null,
        loadIssue: {
          severity: "error",
          code: "CLAIMS_FILE_MISSING",
          message: `Claims file not found at ${path}.`,
          path,
        },
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      claims: null,
      loadIssue: {
        severity: "error",
        code: "CLAIMS_FILE_INVALID_JSON",
        message: `Claims file at ${path} is not valid JSON.`,
        path,
      },
    };
  }

  if (!isClaimsEnvelope(parsed)) {
    return {
      claims: null,
      loadIssue: {
        severity: "error",
        code: "CLAIMS_FILE_MALFORMED",
        message:
          `Claims file at ${path} must be an object of the form ` +
          `{ "claims": [...] }.`,
        path,
      },
    };
  }

  // Keep only object-shaped entries as Claim candidates; field-level checks
  // happen in validateClaims. (Casting here is safe: downstream code only reads
  // string fields and re-checks each one.)
  return { claims: parsed.claims as Claim[], loadIssue: null };
}

/* -------------------------------------------------------------------------- */
/* Loading Observed_Deviations from disk (no throw — bad input → issues)      */
/* -------------------------------------------------------------------------- */

/**
 * The result of attempting to load `observed-deviations.json`: either the
 * parsed deviations, or the issue explaining why they could not be loaded.
 * Exactly one of `deviations` / `loadIssue` is set.
 */
interface LoadedDeviations {
  deviations: ObservedDeviation[] | null;
  loadIssue: ValidationIssue | null;
}

/** Narrow an unknown parsed value to a `{ deviations: unknown[] }` envelope. */
function isDeviationsEnvelope(
  value: unknown,
): value is { deviations: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { deviations?: unknown }).deviations)
  );
}

/**
 * Load and shallow-parse the Observed_Deviations file for a spec root WITHOUT
 * throwing on bad input. A missing file, invalid JSON, or a non-`{ deviations:
 * [] }` shape each come back as a `loadIssue` so the caller can report them
 * structurally.
 *
 * A MISSING file is treated as an error (code `DEVIATIONS_FILE_MISSING`),
 * mirroring the task-6.1 precedent for a missing `claims.json`: an analysis run
 * that completed is expected to WRITE the artifact, and R2.3's "empty list is
 * valid" case is modeled by a present file whose `deviations` array is empty —
 * which is distinct from the artifact being absent entirely.
 *
 * Note: this does not validate individual deviations (that is
 * {@link validateObservedDeviations}'s job) — on success it only guarantees
 * `deviations` is an array to be field-checked downstream.
 */
async function loadObservedDeviations(
  specRoot: string,
): Promise<LoadedDeviations> {
  const path = observedDeviationsFilePath(specRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // ENOENT is the "artifact not authored" case; anything else (e.g. EACCES)
    // is an unexpected host failure and should propagate.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        deviations: null,
        loadIssue: {
          severity: "error",
          code: "DEVIATIONS_FILE_MISSING",
          message: `Observed_Deviations file not found at ${path}.`,
          path,
        },
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      deviations: null,
      loadIssue: {
        severity: "error",
        code: "DEVIATIONS_FILE_INVALID_JSON",
        message: `Observed_Deviations file at ${path} is not valid JSON.`,
        path,
      },
    };
  }

  if (!isDeviationsEnvelope(parsed)) {
    return {
      deviations: null,
      loadIssue: {
        severity: "error",
        code: "DEVIATIONS_FILE_MALFORMED",
        message:
          `Observed_Deviations file at ${path} must be an object of the form ` +
          `{ "deviations": [...] }.`,
        path,
      },
    };
  }

  // Keep every entry as an ObservedDeviation candidate; field-level checks
  // happen in validateObservedDeviations. (Casting is safe: downstream code
  // re-checks each field.)
  return {
    deviations: parsed.deviations as ObservedDeviation[],
    loadIssue: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Enumerating the property/ directory (no throw — missing dir = empty)       */
/* -------------------------------------------------------------------------- */

/**
 * A discovered property test file: its basename, its full path, and the parsed
 * `{n}.{claimId}` stem (null when the filename does not follow the convention).
 */
export interface DiscoveredPropertyFile {
  fileName: string;
  path: string;
  parsed: ParsedPropertyTestFileName | null;
}

/**
 * A discovered property test file paired with its already-read source text, so
 * the task-6.3 runnability core ({@link validatePropertyTestFiles}) can stay
 * I/O-free: the wrapper reads the bytes (host-safe — reading TEXT, never
 * executing), the core only inspects the string.
 */
export interface DiscoveredPropertyFileWithSource {
  file: DiscoveredPropertyFile;
  source: string;
}

/**
 * Enumerate the Correctness_Property test files under `{specRoot}/properties/`.
 *
 * A missing `properties/` directory is NOT an error at this layer — it simply
 * means zero property files (the per-Claim checks then report each expressible
 * Claim's missing property). Non-convention filenames are still returned (with
 * `parsed === null`) so callers can decide how to treat them; the 1:1 mapping
 * check only consumes files whose name parses.
 *
 * Exported so the task-6.3 runnability wrapper can reuse the SAME enumeration
 * (rather than duplicating it) and then read each file's source on top.
 */
export async function discoverPropertyFiles(
  specRoot: string,
): Promise<DiscoveredPropertyFile[]> {
  // The `properties/` directory, joined the same POSIX way the layout helpers
  // in `@spec-lantern/types` build every artifact path.
  const dir = `${specRoot.replace(/\/+$/, "")}/${ARTIFACT_PATHS.propertiesDir}`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((name) => name.endsWith(".test.ts"))
    .map((fileName) => ({
      fileName,
      path: `${dir}/${fileName}`,
      parsed: parsePropertyTestFileName(fileName),
    }));
}

/**
 * Enumerate the property test files AND read each one's source text, reusing
 * {@link discoverPropertyFiles} for the directory walk.
 *
 * HOST SAFETY: this only READS the file's text — it never imports, requires, or
 * executes it. Running a property test is the Isolated_Runner's job (tasks
 * 8–12) and must never happen on the host (R12.1); the task-6.3 Validator pass
 * is a purely STATIC author-time guard on the artifact's shape.
 *
 * A file that disappears between the directory walk and the read (ENOENT) is
 * treated as an empty source so the static core reports it as an empty/invalid
 * artifact rather than throwing; any other read error (e.g. EACCES) is an
 * unexpected host failure and propagates, mirroring the loader discipline above.
 */
async function discoverPropertyFilesWithSource(
  specRoot: string,
): Promise<DiscoveredPropertyFileWithSource[]> {
  const files = await discoverPropertyFiles(specRoot);
  return Promise.all(
    files.map(async (file) => {
      let source: string;
      try {
        source = await readFile(file.path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          source = "";
        } else {
          throw error;
        }
      }
      return { file, source };
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Task 6.1 — Claim / 1:1 mapping / unverifiable validation                   */
/* -------------------------------------------------------------------------- */

/**
 * Validate the Claims set and its mapping to Correctness_Property test files
 * (task 6.1). This is the pure core of the check: it takes the already-loaded
 * Claims and the already-discovered property files and reports, without any I/O
 * or throwing:
 *
 *  - R1.3 — every Claim carries a non-empty `sourceFile` and `commentRef`
 *           (and a non-empty `id`; duplicate ids are also flagged);
 *  - R3.1 — every EXPRESSIBLE Claim (no `unverifiable` field) maps to EXACTLY
 *           ONE property test file whose parsed `claimId` equals the Claim id —
 *           zero files and multiple files are both errors;
 *  - R3.6 — every UNVERIFIABLE Claim carries a non-empty `reason` AND has ZERO
 *           property test files referencing it;
 *  - dangling — any property test file whose `claimId` matches no Claim.
 *
 * Splitting this from {@link validateClaimArtifacts} keeps the logic unit-
 * testable with hand-built inputs while the I/O wrapper handles disk reads.
 */
export function validateClaims(
  claims: Claim[],
  propertyFiles: DiscoveredPropertyFile[],
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Index property files by the claimId parsed from their filename. Files whose
  // name does not follow the convention are ignored here (an authoring step,
  // not this check, owns filename-shape enforcement).
  const filesByClaimId = new Map<string, DiscoveredPropertyFile[]>();
  for (const file of propertyFiles) {
    if (!file.parsed) continue;
    const list = filesByClaimId.get(file.parsed.claimId) ?? [];
    list.push(file);
    filesByClaimId.set(file.parsed.claimId, list);
  }

  const seenIds = new Set<string>();
  const knownClaimIds = new Set<string>();

  for (const claim of claims) {
    const claimId = claim?.id;

    // ---- id presence + uniqueness --------------------------------------
    if (!isNonEmptyString(claimId)) {
      issues.push({
        severity: "error",
        code: "CLAIM_ID_EMPTY",
        message: "A Claim is missing a non-empty `id`.",
      });
      // Without an id we cannot resolve mapping for this Claim; still check its
      // other fields below using whatever id-less context we have.
    } else {
      if (seenIds.has(claimId)) {
        issues.push({
          severity: "error",
          code: "CLAIM_ID_DUPLICATE",
          message: `Duplicate Claim id "${claimId}".`,
          claimId,
        });
      }
      seenIds.add(claimId);
      knownClaimIds.add(claimId);
    }

    // ---- R1.3: non-empty origin references -----------------------------
    if (!isNonEmptyString(claim?.sourceFile)) {
      issues.push({
        severity: "error",
        code: "CLAIM_SOURCE_FILE_EMPTY",
        message: `Claim "${claimId ?? "<no id>"}" must carry a non-empty sourceFile (R1.3).`,
        claimId: isNonEmptyString(claimId) ? claimId : undefined,
      });
    }
    if (!isNonEmptyString(claim?.commentRef)) {
      issues.push({
        severity: "error",
        code: "CLAIM_COMMENT_REF_EMPTY",
        message: `Claim "${claimId ?? "<no id>"}" must carry a non-empty commentRef (R1.3).`,
        claimId: isNonEmptyString(claimId) ? claimId : undefined,
      });
    }

    // Mapping checks need a usable id.
    if (!isNonEmptyString(claimId)) continue;

    const matchingFiles = filesByClaimId.get(claimId) ?? [];
    const unverifiable = claim?.unverifiable;

    if (unverifiable !== undefined) {
      // ---- R3.6: unverifiable Claim --------------------------------------
      if (!isNonEmptyString(unverifiable?.reason)) {
        issues.push({
          severity: "error",
          code: "UNVERIFIABLE_REASON_EMPTY",
          message: `Unverifiable Claim "${claimId}" must record a non-empty reason (R3.6).`,
          claimId,
        });
      }
      // An unverifiable Claim must emit NO property test file.
      if (matchingFiles.length > 0) {
        issues.push({
          severity: "error",
          code: "UNVERIFIABLE_CLAIM_HAS_PROPERTY",
          message:
            `Unverifiable Claim "${claimId}" must not have a property test file, ` +
            `but found ${matchingFiles.length} (R3.6): ` +
            matchingFiles.map((f) => f.fileName).join(", "),
          claimId,
          path: matchingFiles[0]?.path,
        });
      }
    } else {
      // ---- R3.1: expressible Claim maps 1:1 to exactly one property ------
      if (matchingFiles.length === 0) {
        issues.push({
          severity: "error",
          code: "EXPRESSIBLE_CLAIM_NO_PROPERTY",
          message: `Expressible Claim "${claimId}" has no Correctness_Property test file (R3.1).`,
          claimId,
        });
      } else if (matchingFiles.length > 1) {
        issues.push({
          severity: "error",
          code: "EXPRESSIBLE_CLAIM_MULTIPLE_PROPERTIES",
          message:
            `Expressible Claim "${claimId}" maps to ${matchingFiles.length} property ` +
            `test files but must map to exactly one (R3.1): ` +
            matchingFiles.map((f) => f.fileName).join(", "),
          claimId,
          path: matchingFiles[0]?.path,
        });
      }
    }
  }

  // ---- dangling property files: a file for a claimId with no Claim --------
  for (const [claimId, files] of filesByClaimId) {
    if (knownClaimIds.has(claimId)) continue;
    for (const file of files) {
      issues.push({
        severity: "error",
        code: "PROPERTY_FILE_DANGLING",
        message:
          `Property test file "${file.fileName}" references Claim id "${claimId}", ` +
          `which does not correspond to any Claim.`,
        claimId,
        path: file.path,
      });
    }
  }

  return makeResult(issues);
}

/* -------------------------------------------------------------------------- */
/* Task 6.2 — Observed_Deviations reference / shape validation (R2.1–R2.4)     */
/* -------------------------------------------------------------------------- */

/**
 * Validate the Observed_Deviations set (task 6.2). This is the pure core of the
 * check: it takes the already-loaded deviations plus the ids of the known
 * Claims and reports, without any I/O or throwing:
 *
 *  - R2.1/R2.2 — every deviation REFERENCES a valid originating Claim: its
 *                `claimId` is non-empty AND corresponds to an existing Claim
 *                (a dangling reference is an error);
 *  - R2.1     — every deviation carries a non-empty `claimedBehavior`, plus
 *                EITHER a non-empty `currentBehavior` OR a valid undeterminable
 *                marker (R2.4). A deviation with neither is an error, and an
 *                `undeterminable`/`currentBehavior` DISAGREEMENT (one set
 *                without the other) is an error;
 *  - R2.3     — the EMPTY LIST is valid: zero deviations produces zero issues;
 *  - R2.4     — an undeterminable entry (null `currentBehavior` +
 *                `undeterminable === true`) is valid in its own right and is
 *                validated INDEPENDENTLY of every other entry, so it never
 *                suppresses or invalidates the other evaluated Claims.
 *
 * `id` presence and uniqueness are also checked so a deviation is addressable
 * and the collection is well-formed, mirroring the Claim-id checks in
 * {@link validateClaims}.
 *
 * Splitting this from {@link validateObservedDeviationArtifacts} keeps the logic
 * unit-testable with hand-built inputs while the I/O wrapper handles disk reads
 * and resolving the known Claim ids.
 */
export function validateObservedDeviations(
  deviations: ObservedDeviation[],
  knownClaimIds: Iterable<string>,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const knownIds = new Set(knownClaimIds);
  const seenIds = new Set<string>();

  // R2.3: an empty list is valid — the loop simply does not run and no issues
  // are produced. Each entry below is validated INDEPENDENTLY (R2.4): an
  // undeterminable or otherwise-invalid entry only contributes its own issues
  // and never short-circuits the evaluation of the remaining entries.
  for (const deviation of deviations) {
    const deviationId = deviation?.id;

    // ---- id presence + uniqueness --------------------------------------
    if (!isNonEmptyString(deviationId)) {
      issues.push({
        severity: "error",
        code: "DEVIATION_ID_EMPTY",
        message: "An Observed_Deviation is missing a non-empty `id`.",
      });
    } else {
      if (seenIds.has(deviationId)) {
        issues.push({
          severity: "error",
          code: "DEVIATION_ID_DUPLICATE",
          message: `Duplicate Observed_Deviation id "${deviationId}".`,
        });
      }
      seenIds.add(deviationId);
    }

    const label = isNonEmptyString(deviationId) ? deviationId : "<no id>";
    const claimId = deviation?.claimId;

    // ---- R2.1/R2.2: references a valid originating Claim ----------------
    if (!isNonEmptyString(claimId)) {
      issues.push({
        severity: "error",
        code: "DEVIATION_CLAIM_ID_EMPTY",
        message: `Observed_Deviation "${label}" must reference an originating Claim via a non-empty claimId (R2.1).`,
      });
    } else if (!knownIds.has(claimId)) {
      issues.push({
        severity: "error",
        code: "DEVIATION_CLAIM_ID_DANGLING",
        message:
          `Observed_Deviation "${label}" references Claim id "${claimId}", ` +
          `which does not correspond to any Claim (R2.1/R2.2).`,
        claimId,
      });
    }

    // ---- R2.1: claimed behavior present --------------------------------
    if (!isNonEmptyString(deviation?.claimedBehavior)) {
      issues.push({
        severity: "error",
        code: "DEVIATION_CLAIMED_BEHAVIOR_EMPTY",
        message: `Observed_Deviation "${label}" must carry a non-empty claimedBehavior (R2.1).`,
        claimId: isNonEmptyString(claimId) ? claimId : undefined,
      });
    }

    // ---- R2.1/R2.4: current behavior OR an undeterminable marker --------
    // The contract: a deviation carries claimed behavior PLUS exactly one of
    //   (a) a non-empty currentBehavior (undeterminable absent/false), or
    //   (b) undeterminable === true WITH currentBehavior === null.
    // The marker and the null currentBehavior must agree.
    const undeterminable = deviation?.undeterminable === true;
    const currentIsNull = deviation?.currentBehavior === null;
    const currentIsNonEmpty = isNonEmptyString(deviation?.currentBehavior);

    if (undeterminable !== currentIsNull) {
      // Marker set without a null currentBehavior, or null currentBehavior
      // without the marker — the two must travel together (R2.4).
      issues.push({
        severity: "error",
        code: "DEVIATION_UNDETERMINABLE_MISMATCH",
        message:
          `Observed_Deviation "${label}" must have \`undeterminable: true\` exactly when ` +
          `\`currentBehavior\` is null (R2.4); the marker and the null current behavior must agree.`,
        claimId: isNonEmptyString(claimId) ? claimId : undefined,
      });
    } else if (!undeterminable && !currentIsNonEmpty) {
      // Not undeterminable and no usable currentBehavior (e.g. empty string or
      // a missing field): the deviation carries neither current behavior nor a
      // valid undeterminable marker (R2.1/R2.4).
      issues.push({
        severity: "error",
        code: "DEVIATION_MISSING_CURRENT_BEHAVIOR",
        message:
          `Observed_Deviation "${label}" must carry either a non-empty currentBehavior or ` +
          `an undeterminable marker (undeterminable: true with currentBehavior: null) (R2.1/R2.4).`,
        claimId: isNonEmptyString(claimId) ? claimId : undefined,
      });
    }
  }

  return makeResult(issues);
}

/* -------------------------------------------------------------------------- */
/* Task 6.3 — property-test-file runnability (static, host-safe) (R3.2)        */
/* -------------------------------------------------------------------------- */

/**
 * Heuristic: does the source contain at least one Vitest test ENTRY POINT?
 *
 * We look for a `test(`, `it(`, or `describe(` call token (optionally preceded
 * by `.`, e.g. `test.each(`/`it.skip(` still have a `test`/`it` word-boundary
 * start). This is intentionally a shape heuristic, not a parser: it evidences
 * the file registers at least one runnable case the runner can invoke.
 */
function hasTestEntryPoint(source: string): boolean {
  return /\b(?:test|it|describe)\s*(?:\.\s*\w+\s*)?\(/.test(source);
}

/**
 * Heuristic: does the source contain at least one ASSERTION / termination
 * signal that can drive a FAIL verdict?
 *
 * We accept any of:
 *  - a Vitest `expect(` call,
 *  - a fast-check `fc.assert(` or `fc.property(` / `fc.asyncProperty(` (the
 *    property-based path the spec's properties use — `fc.assert` throws on a
 *    falsified property, which surfaces as the runner's FAIL),
 *  - a bare `assert(`/`assert.` from `node:assert`.
 *
 * Without at least one of these, the test body cannot FAIL on bad behavior and
 * would trivially pass, so the artifact is not shaped to yield a real PASS/FAIL.
 */
function hasAssertion(source: string): boolean {
  return (
    /\bexpect\s*\(/.test(source) ||
    /\bfc\s*\.\s*(?:assert|property|asyncProperty)\s*\(/.test(source) ||
    /\bassert\s*[.(]/.test(source)
  );
}

/**
 * Validate that every Correctness_Property test file is RUNNABLE and shaped to
 * TERMINATE with exactly one of PASS or FAIL (task 6.3, R3.2). This is the pure
 * core: it takes the already-read file sources and reports, without any I/O or
 * throwing, STATIC, host-safe findings on each artifact's shape.
 *
 * IMPORTANT — what "runnable and terminates PASS/FAIL" means HERE. The Validator
 * performs STATIC artifact validation only; it NEVER executes a test file
 * (executing Target_Repo / test code is the Isolated_Runner's job in tasks
 * 8–12, and the host-safety invariant R12.1 forbids running that code on the
 * host). Genuine RUNTIME termination in a PASS/FAIL verdict — including the
 * timeout path — is enforced at EXECUTION time by the runner (R5.5–R5.9). This
 * pass is the AUTHOR-TIME guard that the artifact is shaped so that, when the
 * runner does execute it, it CAN reach a PASS/FAIL rather than being an empty,
 * mis-named, or inert file. Concretely it checks, per file:
 *
 *  - NAMING   — the basename follows `property-{n}.{claimId}.test.ts`
 *               (`file.parsed !== null`); a non-convention name under
 *               `properties/` is flagged (`PROPERTY_FILE_NAME_NON_CONVENTION`)
 *               and the remaining content checks are skipped (the file is not a
 *               recognizable property artifact);
 *  - NON-EMPTY — the source is not empty/whitespace-only
 *               (`PROPERTY_FILE_EMPTY`);
 *  - TAG      — the required `Feature: spec-lantern, Property {n}: {text}` tag
 *               is present (`PROPERTY_FILE_TAG_MISSING`) AND its `{n}` agrees
 *               with the filename's property number
 *               (`PROPERTY_FILE_TAG_NUMBER_MISMATCH`);
 *  - ENTRY    — at least one Vitest entry point `test(`/`it(`/`describe(`
 *               exists (`PROPERTY_FILE_NO_TEST_ENTRY_POINT`);
 *  - ASSERT   — at least one assertion / termination signal exists — `expect(`,
 *               a fast-check `fc.assert`/`fc.property`, or `assert`
 *               (`PROPERTY_FILE_NO_ASSERTION`).
 *
 * The entry-point and assertion checks are deliberately token-shape HEURISTICS,
 * not a full parse: they are cheap, host-safe, and sufficient to catch the
 * failure modes the convention cares about (an empty or inert file that can
 * never reach a verdict) while a well-formed property file written like the
 * walking-skeleton property always satisfies them.
 *
 * Splitting this from {@link validatePropertyTestFileArtifacts} keeps the logic
 * unit-testable with hand-built `{ file, source }` inputs while the I/O wrapper
 * handles the directory walk and the host-safe text reads.
 */
export function validatePropertyTestFiles(
  files: DiscoveredPropertyFileWithSource[],
): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const { file, source } of files) {
    // ---- NAMING: must follow property-{n}.{claimId}.test.ts --------------
    if (!file.parsed) {
      issues.push({
        severity: "error",
        code: "PROPERTY_FILE_NAME_NON_CONVENTION",
        message:
          `Property test file "${file.fileName}" does not follow the ` +
          `\`property-{n}.{claimId}.test.ts\` naming convention (R3.2).`,
        path: file.path,
      });
      // Without a parsed name we cannot tie the file to a Claim or compare its
      // tag number; the remaining content checks are not meaningful.
      continue;
    }

    const claimId = file.parsed.claimId;

    // ---- NON-EMPTY: an empty file can never reach a verdict --------------
    if (source.trim().length === 0) {
      issues.push({
        severity: "error",
        code: "PROPERTY_FILE_EMPTY",
        message:
          `Property test file "${file.fileName}" is empty and cannot ` +
          `terminate with a PASS or FAIL verdict (R3.2).`,
        claimId,
        path: file.path,
      });
      // Nothing more to check in an empty file.
      continue;
    }

    // ---- TAG: present AND its number agrees with the filename ------------
    const tag = parsePropertyTag(source);
    if (!tag) {
      issues.push({
        severity: "error",
        code: "PROPERTY_FILE_TAG_MISSING",
        message:
          `Property test file "${file.fileName}" is missing the required ` +
          `\`Feature: spec-lantern, Property {n}: {text}\` tag comment (R3.2).`,
        claimId,
        path: file.path,
      });
    } else if (tag.propertyNumber !== file.parsed.propertyNumber) {
      issues.push({
        severity: "error",
        code: "PROPERTY_FILE_TAG_NUMBER_MISMATCH",
        message:
          `Property test file "${file.fileName}" declares property number ` +
          `${file.parsed.propertyNumber} in its filename but ` +
          `${tag.propertyNumber} in its tag; they must agree (R3.2).`,
        claimId,
        path: file.path,
      });
    }

    // ---- ENTRY POINT: at least one runnable test case --------------------
    if (!hasTestEntryPoint(source)) {
      issues.push({
        severity: "error",
        code: "PROPERTY_FILE_NO_TEST_ENTRY_POINT",
        message:
          `Property test file "${file.fileName}" contains no Vitest entry ` +
          `point (\`test(\`/\`it(\`/\`describe(\`); there is nothing to run ` +
          `and no path to a PASS/FAIL verdict (R3.2).`,
        claimId,
        path: file.path,
      });
    }

    // ---- ASSERTION: at least one termination signal ----------------------
    if (!hasAssertion(source)) {
      issues.push({
        severity: "error",
        code: "PROPERTY_FILE_NO_ASSERTION",
        message:
          `Property test file "${file.fileName}" contains no assertion ` +
          `(\`expect(\`, a fast-check \`fc.assert\`/\`fc.property\`, or ` +
          `\`assert\`); it cannot FAIL and so is not shaped to yield a real ` +
          `PASS/FAIL verdict (R3.2).`,
        claimId,
        path: file.path,
      });
    }
  }

  return makeResult(issues);
}

/* -------------------------------------------------------------------------- */
/* I/O wrapper + spec composition                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read the Claims and the `properties/` directory from a spec root and run the
 * task-6.1 Claim/mapping/unverifiable validation. On a load failure (missing
 * file, bad JSON, wrong shape) this returns a single load issue rather than
 * throwing; genuinely unexpected host errors (e.g. a permission error) still
 * propagate.
 */
export async function validateClaimArtifacts(
  specRoot: string,
): Promise<ValidationResult> {
  const loaded = await loadClaims(specRoot);
  if (loaded.claims === null) {
    // loadIssue is guaranteed set when claims is null.
    return makeResult([loaded.loadIssue as ValidationIssue]);
  }
  const propertyFiles = await discoverPropertyFiles(specRoot);
  return validateClaims(loaded.claims, propertyFiles);
}

/**
 * Read the Observed_Deviations and the Claims from a spec root and run the
 * task-6.2 reference/shape validation. The Claims are loaded only to resolve
 * the set of KNOWN Claim ids the deviations must reference (R2.1/R2.2); the
 * per-Claim contracts themselves are task 6.1's job via
 * {@link validateClaimArtifacts}, so a Claims-load failure here does NOT
 * duplicate that reporting — it just means no ids are known, so every
 * deviation's reference is treated as dangling.
 *
 * On a deviations-load failure (missing file, bad JSON, wrong shape) this
 * returns a single load issue rather than throwing; genuinely unexpected host
 * errors (e.g. a permission error) still propagate.
 */
export async function validateObservedDeviationArtifacts(
  specRoot: string,
): Promise<ValidationResult> {
  const loaded = await loadObservedDeviations(specRoot);
  if (loaded.deviations === null) {
    // loadIssue is guaranteed set when deviations is null.
    return makeResult([loaded.loadIssue as ValidationIssue]);
  }

  // Resolve the known Claim ids. A Claims-load failure is reported by the 6.1
  // pass (validateClaimArtifacts); here we simply fall back to "no known ids",
  // which surfaces dangling references rather than masking the missing Claims.
  const loadedClaims = await loadClaims(specRoot);
  const knownClaimIds = (loadedClaims.claims ?? [])
    .map((claim) => claim?.id)
    .filter((id): id is string => isNonEmptyString(id));

  return validateObservedDeviations(loaded.deviations, knownClaimIds);
}

/**
 * Read the `properties/` directory from a spec root and run the task-6.3 static
 * runnability check on each property test file. The files' sources are READ
 * (host-safe text reads — never executed; see
 * {@link validatePropertyTestFiles}) and handed to the pure core.
 *
 * A missing `properties/` directory simply yields zero files and zero issues
 * here; the per-Claim "expressible Claim has no property" finding is task 6.1's
 * job, so this pass does not duplicate it. Genuinely unexpected host errors
 * (e.g. a permission error reading a file) still propagate.
 */
export async function validatePropertyTestFileArtifacts(
  specRoot: string,
): Promise<ValidationResult> {
  const files = await discoverPropertyFilesWithSource(specRoot);
  return validatePropertyTestFiles(files);
}

/**
 * Validate a whole spec root. This folds the task-6.1 Claim/mapping check, the
 * task-6.2 Observed_Deviations reference/shape check, and the task-6.3 static
 * property-test-file runnability check, so callers can keep calling this one
 * entry point.
 */
export async function validateSpec(
  specRoot: string,
): Promise<ValidationResult> {
  return combineResults(
    await validateClaimArtifacts(specRoot),
    await validateObservedDeviationArtifacts(specRoot),
    await validatePropertyTestFileArtifacts(specRoot),
  );
}
