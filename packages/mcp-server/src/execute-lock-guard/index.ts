/**
 * @spec-lantern/mcp-server — the execute-time lock guard (GAP 1).
 *
 * A Prediction_Lock hashes the Correctness_Property test file it was taken over
 * (its `propertyContentHash`). If the author edits that property file AFTER
 * locking, the run would no longer be executing the source the prediction was
 * locked against — the whole "predict, lock, then execute" guarantee leaks. The
 * fourth packaged-power trial on writing-tracker edited property files six times
 * after locking with NO record; this guard closes that gap.
 *
 * Before `execute_properties` dispatches a property, it asks this guard whether
 * the property's CURRENT source still matches its locked `propertyContentHash`:
 *
 *   - No lock exists for the property  => ALLOW. Locking is a SEPARATE
 *     precondition (00-pipeline-and-safety.md); the guard does not invent a new
 *     "must be locked" error, it only refuses a property that drifted from a
 *     lock that DOES exist.
 *   - A lock exists and the hashes match => ALLOW, and record the matched hash
 *     so the execution result is traceable to the exact property source.
 *   - A lock exists and the hashes differ => REFUSE, naming the property and
 *     telling the author to record a supersede (`supersede_prediction_lock`),
 *     which re-locks the edited source keeping the predicted verdict. A manual
 *     edit can never quietly bypass the refusal.
 *
 * The superseded-notes trail under `locks/superseded/` is NOT consulted here:
 * the active lock is authoritative, so a supersede that re-locks the edited
 * source makes the active `propertyContentHash` match again and the guard
 * allows the run. The refusal is purely active-lock-vs-current-source.
 *
 * Design discipline (mirrors prediction-lock / validator): PURE and NO-THROW on
 * expected input. Reading/parsing a property file or lock only ever yields a
 * structured outcome; only unexpected host errors (e.g. a permission failure
 * other than ENOENT) propagate. It reads TEXT only and never executes a file.
 */
import { readFile } from "node:fs/promises";
import type { CorrectnessProperty } from "@spec-lantern/types";
import {
  parsePropertyTestFileName,
  resolveClaimLinkage,
} from "@spec-lantern/types";
import { computePropertyContentHash } from "../prediction-lock/index.js";

/** A property that drifted from its lock and why it was refused. */
export interface RefusedProperty {
  propertyId: string;
  reason: string;
}

/** Outcome of the drift check over a set of properties. */
export interface LockDriftResult {
  /** Properties cleared to run (no lock, or a lock whose hash still matches). */
  allowed: CorrectnessProperty[];
  /** Properties whose source drifted from an existing lock. */
  refused: RefusedProperty[];
  /**
   * propertyId -> the sha256 of the property source actually checked, recorded
   * ONLY for properties that had a lock (so a persisted result is traceable to
   * the exact locked source). A property with no lock contributes no entry.
   */
  propertyContentHashes: Record<string, string>;
}

/** Input to {@link checkPropertyLockDrift}. */
export interface CheckPropertyLockDriftInput {
  /** Spec root holding `properties/`, `predictions/`, and `locks/`. */
  specRoot: string;
  /** The properties about to be executed. */
  properties: CorrectnessProperty[];
}

/** Read a UTF-8 file, returning `null` on ENOENT; other errors propagate. */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Parse a property `id` (the `property-{n}.{claimId}` stem) into its parts by
 * reusing the filename convention parser. Returns `null` if it does not follow
 * the convention (the caller then ALLOWS it — there is nothing to compare).
 */
function parsePropertyId(
  id: string,
): { propertyNumber: number; claimId: string } | null {
  return parsePropertyTestFileName(`${id}.test.ts`);
}

/** The lock's `propertyContentHash`, or `null` when no usable lock exists. */
function lockedPropertyHash(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const hash = (parsed as { propertyContentHash?: unknown }).propertyContentHash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/**
 * Check each property's current source against its lock's
 * `propertyContentHash`, partitioning them into allowed/refused and recording
 * the hash actually run against for every property that had a lock (GAP 1).
 *
 * See the module overview for the ALLOW/REFUSE rules. Never throws on an
 * expected condition (missing lock, missing property file, malformed lock).
 */
export async function checkPropertyLockDrift(
  input: CheckPropertyLockDriftInput,
): Promise<LockDriftResult> {
  const { specRoot, properties } = input;
  const allowed: CorrectnessProperty[] = [];
  const refused: RefusedProperty[] = [];
  const propertyContentHashes: Record<string, string> = {};

  for (const property of properties) {
    const parsedId = parsePropertyId(property.id);
    if (parsedId === null) {
      // The id is not on the canonical layout, so no lock can be resolved for
      // it — nothing to compare against. Allow it (locking is a separate
      // precondition the guard does not re-impose here).
      allowed.push(property);
      continue;
    }

    const linkage = resolveClaimLinkage(
      specRoot,
      parsedId.claimId,
      parsedId.propertyNumber,
    );

    const lockRaw = await readTextOrNull(linkage.predictionLockFile);
    if (lockRaw === null) {
      // No lock for this property => ALLOW (do not invent a "must be locked"
      // error; that is a separate precondition).
      allowed.push(property);
      continue;
    }

    let lockedHash: string | null = null;
    try {
      lockedHash = lockedPropertyHash(JSON.parse(lockRaw));
    } catch {
      lockedHash = null;
    }
    if (lockedHash === null) {
      // The lock is present but malformed / predates propertyContentHash. There
      // is no property-source hash to compare against, so do not fabricate a
      // drift refusal; allow and let the comparison engine surface the lock's
      // own integrity issue.
      allowed.push(property);
      continue;
    }

    const propertySource = await readTextOrNull(linkage.propertyTestFile);
    if (propertySource === null) {
      refused.push({
        propertyId: property.id,
        reason:
          `The Correctness_Property test file for "${property.id}" is missing ` +
          `at ${linkage.propertyTestFile}, but a lock exists for it. Restore ` +
          `the property file or record a supersede (supersede_prediction_lock).`,
      });
      continue;
    }

    const currentHash = computePropertyContentHash(propertySource);
    if (currentHash === lockedHash) {
      allowed.push(property);
      propertyContentHashes[property.id] = currentHash;
      continue;
    }

    refused.push({
      propertyId: property.id,
      reason:
        `The property test file for "${property.id}" changed after it was ` +
        `locked (current hash ${currentHash.slice(0, 12)}… does not match the ` +
        `locked ${lockedHash.slice(0, 12)}…). Execution is refused. Record a ` +
        `supersede with supersede_prediction_lock — it archives the old lock ` +
        `under locks/superseded/ and re-locks the edited source keeping the ` +
        `predicted verdict — then run again.`,
    });
  }

  return { allowed, refused, propertyContentHashes };
}
