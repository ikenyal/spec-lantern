/**
 * @spec-lantern/mcp-server — the prediction-lock tool (task 7.1).
 *
 * Kiro records a Predicted_Result — the PASS/FAIL it predicts for a
 * Correctness_Property by READING the code — before the property is ever
 * executed (R3.4). Once execution begins that prediction is IMMUTABLE: any
 * later comparison (the Comparison Engine, task 14) must use the ORIGINALLY
 * recorded value, never a prediction edited to match what execution found
 * (R3.5). That is the whole point of "execute, don't trust": a prediction that
 * can be quietly rewritten after seeing the result proves nothing.
 *
 * This module is the MCP_Server's LOCK responsibility. At the execution-start
 * boundary it computes a content hash (SHA-256) + timestamp over each
 * Predicted_Result AND the bytes of the Correctness_Property test file the
 * prediction refers to, and PERSISTS a Prediction_Lock on disk (under the
 * spec's `locks/` directory; see `@spec-lantern/types` `./artifacts.ts` for the
 * canonical layout and schema). The lock:
 *
 *   - captures the originally recorded `verdict` directly, so a reader has the
 *     immutable value without re-reading (and re-trusting) the prediction file;
 *   - carries a `contentHash` over the prediction + the property artifact, so
 *     if EITHER is edited after the lock is written, recomputing the hash no
 *     longer matches and the drift is detectable (tamper-evidence);
 *   - stamps `lockedAt`, evidencing the lock predates execution.
 *
 * Reading the lock back (for task 14's comparison) is {@link readPredictionLock}
 * and {@link readLockedVerdict}: they return the LOCKED verdict, and flag — but
 * never silently honor — a prediction or property file that has drifted from
 * the hash the lock was taken over.
 *
 * Design discipline mirrored from the Validator (`../validator/index.ts`):
 *  - HOST-SAFE. This module only reads/writes TEXT (prediction JSON, the
 *    property test file's bytes, the lock JSON). It NEVER imports, requires, or
 *    executes a property test file — executing Target_Repo/test code is the
 *    Isolated_Runner's job (tasks 8–12) and must never happen on the host
 *    (R12.1). Hashing reads the file's BYTES, it does not run it.
 *  - NO THROW on expected-but-invalid input. A missing prediction, invalid
 *    JSON, a non-PASS/FAIL verdict, a missing property artifact, or a drifted
 *    lock all surface as STRUCTURED outcomes ({@link LockResult} /
 *    {@link LockReadResult}) a caller can switch on. Only genuinely unexpected
 *    host failures (e.g. a permission error) propagate.
 *  - CLOSED outcome union. {@link LockCode} enumerates every way locking or
 *    reading can fail; a caller can exhaustively handle them.
 *
 * Requirements traceability: 3.4, 3.5.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PredictedResult, PredictionLock, Verdict } from "@spec-lantern/types";
import {
  PREDICTION_LOCK_HASH_ALGORITHM,
  resolveClaimLinkage,
} from "@spec-lantern/types";

/* -------------------------------------------------------------------------- */
/* Outcome vocabulary (closed union)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Closed enumeration of every way locking or reading a lock can go wrong.
 * A `null` on a result means "no problem of this kind".
 */
export type LockCode =
  /** The Predicted_Result file is missing at the expected path. */
  | "PREDICTION_MISSING"
  /** The Predicted_Result file exists but is not parseable JSON. */
  | "PREDICTION_INVALID_JSON"
  /** The Predicted_Result parsed but is not a well-formed prediction. */
  | "PREDICTION_MALFORMED"
  /** The prediction's propertyId does not match the property being locked. */
  | "PREDICTION_PROPERTY_ID_MISMATCH"
  /** The Correctness_Property test file the prediction refers to is missing. */
  | "PROPERTY_FILE_MISSING"
  /** The lock file is missing at the expected path (read path only). */
  | "LOCK_MISSING"
  /** The lock file exists but is not parseable JSON (read path only). */
  | "LOCK_INVALID_JSON"
  /** The lock file parsed but is not a well-formed lock (read path only). */
  | "LOCK_MALFORMED"
  /**
   * R3.5 VIOLATION: the Predicted_Result and/or the Correctness_Property file
   * have CHANGED since the lock was written — the recomputed content hash
   * disagrees with the stored `contentHash`. The locked verdict is still
   * returned (it is the authoritative, originally recorded value), but the
   * drift is reported so a caller knows an edit was attempted after locking.
   */
  | "LOCK_CONTENT_DRIFT";

/** A single structured lock finding. */
export interface LockIssue {
  code: LockCode;
  /** Human-readable, self-contained explanation. */
  message: string;
  /** The property this issue concerns, when known. */
  propertyId?: string;
  /** The artifact path this issue concerns, when applicable. */
  path?: string;
}

/**
 * Outcome of locking a prediction. Exactly one of `lock` / `issue` is set:
 * on success `lock` is the persisted Prediction_Lock; on an expected failure
 * `issue` explains why no lock was written.
 */
export interface LockResult {
  lock: PredictionLock | null;
  issue: LockIssue | null;
}

/**
 * Outcome of reading a lock back for comparison (task 14).
 *
 * `verdict` is the authoritative, originally recorded value when the lock could
 * be read at all — it is returned EVEN WHEN `issue` reports `LOCK_CONTENT_DRIFT`,
 * because the whole point of the lock is that the ORIGINAL verdict survives a
 * later edit to the prediction or property file (R3.5). `verdict` is only
 * `null` when the lock itself could not be loaded (missing / invalid / malformed).
 */
export interface LockReadResult {
  verdict: Verdict | null;
  lock: PredictionLock | null;
  /** Non-null for drift or a load failure; null on a clean read. */
  issue: LockIssue | null;
}

/* -------------------------------------------------------------------------- */
/* Content hashing (R3.4: hash over prediction + property artifact)           */
/* -------------------------------------------------------------------------- */

/**
 * Canonically serialize a Predicted_Result for hashing. We hash a STABLE
 * projection of exactly the fields that define the prediction — `propertyId`
 * and `verdict` — rather than the raw file bytes, so that cosmetic-only edits
 * (whitespace, key order, a touched `recordedAt`) do NOT count as drift while
 * any change to WHAT was predicted does. The field order here is fixed, so the
 * serialization is deterministic across writer and reader.
 */
function serializePredictionForHash(prediction: {
  propertyId: string;
  verdict: Verdict;
}): string {
  return JSON.stringify({
    propertyId: prediction.propertyId,
    verdict: prediction.verdict,
  });
}

/**
 * Compute the lock's content hash over (a) the canonical prediction projection
 * and (b) the RAW bytes of the Correctness_Property test file. Domain
 * separators between the two parts prevent any ambiguity about where the
 * prediction ends and the property source begins.
 *
 * HOST SAFETY: `propertySource` is the file's TEXT, read by the caller; this
 * function only hashes it — it never executes it.
 */
function computeContentHash(
  prediction: { propertyId: string; verdict: Verdict },
  propertySource: string,
): string {
  const hash = createHash(PREDICTION_LOCK_HASH_ALGORITHM);
  hash.update("prediction\n");
  hash.update(serializePredictionForHash(prediction));
  hash.update("\nproperty\n");
  hash.update(propertySource);
  return hash.digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Loading helpers (no throw on expected-but-invalid input)                   */
/* -------------------------------------------------------------------------- */

/** True for a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True for a verdict value (exactly PASS or FAIL). */
function isVerdict(value: unknown): value is Verdict {
  return value === "PASS" || value === "FAIL";
}

/** Read a UTF-8 text file, returning `null` on ENOENT; other errors propagate. */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The parsed-and-validated Predicted_Result, or a structured issue explaining
 * why it could not be loaded. Exactly one of `prediction` / `issue` is set.
 */
interface LoadedPrediction {
  prediction: PredictedResult | null;
  issue: LockIssue | null;
}

/**
 * Load, parse, and shape-check the Predicted_Result at `path` WITHOUT throwing
 * on expected-but-invalid input. `expectedPropertyId` is checked so a lock is
 * only ever taken over the prediction for the property it belongs to.
 */
async function loadPrediction(
  path: string,
  expectedPropertyId: string,
): Promise<LoadedPrediction> {
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return {
      prediction: null,
      issue: {
        code: "PREDICTION_MISSING",
        message: `Predicted_Result file not found at ${path}.`,
        propertyId: expectedPropertyId,
        path,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      prediction: null,
      issue: {
        code: "PREDICTION_INVALID_JSON",
        message: `Predicted_Result file at ${path} is not valid JSON.`,
        propertyId: expectedPropertyId,
        path,
      },
    };
  }

  const candidate = parsed as Partial<PredictedResult>;
  if (
    !isNonEmptyString(candidate.propertyId) ||
    !isVerdict(candidate.verdict) ||
    !isNonEmptyString(candidate.recordedAt) ||
    candidate.immutable !== true
  ) {
    return {
      prediction: null,
      issue: {
        code: "PREDICTION_MALFORMED",
        message:
          `Predicted_Result at ${path} must have a non-empty propertyId, a ` +
          `verdict of exactly PASS or FAIL, a non-empty recordedAt, and ` +
          `immutable: true.`,
        propertyId: expectedPropertyId,
        path,
      },
    };
  }

  if (candidate.propertyId !== expectedPropertyId) {
    return {
      prediction: null,
      issue: {
        code: "PREDICTION_PROPERTY_ID_MISMATCH",
        message:
          `Predicted_Result at ${path} records propertyId ` +
          `"${candidate.propertyId}" but the property being locked is ` +
          `"${expectedPropertyId}".`,
        propertyId: expectedPropertyId,
        path,
      },
    };
  }

  return { prediction: candidate as PredictedResult, issue: null };
}

/** Narrow an unknown parsed value to a well-formed PredictionLock. */
function isPredictionLock(value: unknown): value is PredictionLock {
  if (typeof value !== "object" || value === null) return false;
  const lock = value as Partial<PredictionLock>;
  return (
    isNonEmptyString(lock.propertyId) &&
    isVerdict(lock.verdict) &&
    lock.hashAlgorithm === PREDICTION_LOCK_HASH_ALGORITHM &&
    typeof lock.contentHash === "string" &&
    /^[0-9a-f]{64}$/.test(lock.contentHash) &&
    isNonEmptyString(lock.lockedAt)
  );
}

/* -------------------------------------------------------------------------- */
/* Locking a prediction (R3.4, R3.5)                                          */
/* -------------------------------------------------------------------------- */

/** A property to lock, identified by the same coordinates the layout uses. */
export interface LockTarget {
  /** Spec root holding the artifacts (claims/properties/predictions/locks). */
  specRoot: string;
  /** The Claim id whose property is being locked. */
  claimId: string;
  /** The property number (`property-{n}.{claimId}.*`). */
  propertyNumber: number;
}

/** Options for {@link lockPrediction}. */
export interface LockPredictionOptions {
  /**
   * The lock timestamp. Defaults to `new Date().toISOString()`. Injectable so
   * callers (and tests) can pin the execution-start boundary deterministically.
   */
  now?: () => string;
}

/**
 * Compute a content hash + timestamp over the property's Predicted_Result and
 * the Correctness_Property test file it refers to, and PERSIST a Prediction_Lock
 * so the prediction cannot silently change once execution begins (R3.4, R3.5).
 *
 * Returns the written {@link PredictionLock} on success, or a structured
 * {@link LockIssue} (missing/invalid prediction, missing property artifact)
 * when no lock could be written. Never throws on those expected conditions;
 * only unexpected host errors propagate.
 *
 * Idempotent in spirit: calling it again with an UNCHANGED prediction and
 * property file reproduces the same `contentHash` (only `lockedAt` differs), so
 * a re-lock is safe. A lock is intended to be taken ONCE, at the execution-start
 * boundary; this module does not itself re-write a lock automatically.
 */
export async function lockPrediction(
  target: LockTarget,
  options: LockPredictionOptions = {},
): Promise<LockResult> {
  const { specRoot, claimId, propertyNumber } = target;
  const linkage = resolveClaimLinkage(specRoot, claimId, propertyNumber);
  const propertyId = `property-${propertyNumber}.${claimId}`;
  const now = options.now ?? (() => new Date().toISOString());

  // 1. Load + validate the Predicted_Result (the thing being locked).
  const loaded = await loadPrediction(linkage.predictedResultFile, propertyId);
  if (loaded.prediction === null) {
    return { lock: null, issue: loaded.issue };
  }

  // 2. Read the Correctness_Property test file's BYTES (text; never executed).
  const propertySource = await readTextOrNull(linkage.propertyTestFile);
  if (propertySource === null) {
    return {
      lock: null,
      issue: {
        code: "PROPERTY_FILE_MISSING",
        message:
          `Correctness_Property test file not found at ` +
          `${linkage.propertyTestFile}; cannot hash it into the lock.`,
        propertyId,
        path: linkage.propertyTestFile,
      },
    };
  }

  // 3. Compute the content hash over (prediction + property artifact).
  const contentHash = computeContentHash(
    { propertyId, verdict: loaded.prediction.verdict },
    propertySource,
  );

  // 4. Persist the lock under locks/.
  const lock: PredictionLock = {
    propertyId,
    verdict: loaded.prediction.verdict,
    hashAlgorithm: PREDICTION_LOCK_HASH_ALGORITHM,
    contentHash,
    lockedAt: now(),
  };

  await mkdir(dirname(linkage.predictionLockFile), { recursive: true });
  await writeFile(
    linkage.predictionLockFile,
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );

  return { lock, issue: null };
}

/* -------------------------------------------------------------------------- */
/* Reading a locked verdict back (R3.5 — comparison reads the locked value)   */
/* -------------------------------------------------------------------------- */

/**
 * Read the Prediction_Lock for a property and return the LOCKED verdict,
 * re-verifying that neither the Predicted_Result nor the Correctness_Property
 * file has drifted from what the lock was taken over.
 *
 * This is what the Comparison Engine (task 14) calls: it always gets the
 * ORIGINALLY recorded verdict (R3.5), and is TOLD — via a `LOCK_CONTENT_DRIFT`
 * issue — when the prediction or property file was edited after locking, so it
 * can surface tampering without ever switching to the edited value. A drift
 * still returns the locked verdict (that is the authoritative value); only an
 * unloadable lock yields a `null` verdict.
 */
export async function readPredictionLock(
  target: LockTarget,
): Promise<LockReadResult> {
  const { specRoot, claimId, propertyNumber } = target;
  const linkage = resolveClaimLinkage(specRoot, claimId, propertyNumber);
  const propertyId = `property-${propertyNumber}.${claimId}`;

  // 1. Load + validate the lock.
  const raw = await readTextOrNull(linkage.predictionLockFile);
  if (raw === null) {
    return {
      verdict: null,
      lock: null,
      issue: {
        code: "LOCK_MISSING",
        message: `Prediction_Lock file not found at ${linkage.predictionLockFile}.`,
        propertyId,
        path: linkage.predictionLockFile,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      verdict: null,
      lock: null,
      issue: {
        code: "LOCK_INVALID_JSON",
        message: `Prediction_Lock file at ${linkage.predictionLockFile} is not valid JSON.`,
        propertyId,
        path: linkage.predictionLockFile,
      },
    };
  }

  if (!isPredictionLock(parsed) || parsed.propertyId !== propertyId) {
    return {
      verdict: null,
      lock: null,
      issue: {
        code: "LOCK_MALFORMED",
        message:
          `Prediction_Lock at ${linkage.predictionLockFile} is not a well-formed ` +
          `lock for property "${propertyId}".`,
        propertyId,
        path: linkage.predictionLockFile,
      },
    };
  }

  const lock = parsed;

  // 2. Re-verify the content hash against the CURRENT prediction + property
  //    file. Both must still be present and unchanged for a clean read; the
  //    locked verdict is authoritative either way.
  const predictionRaw = await readTextOrNull(linkage.predictedResultFile);
  const propertySource = await readTextOrNull(linkage.propertyTestFile);

  if (predictionRaw === null || propertySource === null) {
    // The source artifacts were removed after locking — drift. The lock still
    // carries the authoritative original verdict.
    return {
      verdict: lock.verdict,
      lock,
      issue: {
        code: "LOCK_CONTENT_DRIFT",
        message:
          `The Predicted_Result or Correctness_Property file for "${propertyId}" ` +
          `is missing since the lock was written; the locked verdict ` +
          `(${lock.verdict}) remains authoritative (R3.5).`,
        propertyId,
        path: linkage.predictionLockFile,
      },
    };
  }

  let currentHash: string | null = null;
  try {
    const parsedPrediction = JSON.parse(predictionRaw) as Partial<PredictedResult>;
    if (isVerdict(parsedPrediction.verdict)) {
      currentHash = computeContentHash(
        { propertyId, verdict: parsedPrediction.verdict },
        propertySource,
      );
    }
  } catch {
    currentHash = null;
  }

  if (currentHash === null || currentHash !== lock.contentHash) {
    return {
      verdict: lock.verdict,
      lock,
      issue: {
        code: "LOCK_CONTENT_DRIFT",
        message:
          `The Predicted_Result and/or Correctness_Property for "${propertyId}" ` +
          `has changed since the lock was written (hash mismatch); the locked ` +
          `verdict (${lock.verdict}) remains authoritative and is used for ` +
          `comparison (R3.5).`,
        propertyId,
        path: linkage.predictionLockFile,
      },
    };
  }

  // 3. Clean read: lock present, artifacts unchanged.
  return { verdict: lock.verdict, lock, issue: null };
}

/**
 * Convenience: read just the LOCKED verdict for a property, or `null` when no
 * usable lock exists. Drift does NOT null the verdict — the locked value is
 * authoritative (R3.5) — it is surfaced via {@link readPredictionLock}'s issue
 * for callers that care; this helper is for callers that only need the value.
 */
export async function readLockedVerdict(
  target: LockTarget,
): Promise<Verdict | null> {
  const result = await readPredictionLock(target);
  return result.verdict;
}
