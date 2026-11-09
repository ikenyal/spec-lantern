/**
 * @spec-lantern/mcp-server — the `compare_predictions` tool (change 3).
 *
 * In the end-to-end trial Kiro hand-wrote the comparison between the predicted
 * and the actual verdicts and hand-counted the "lies" (confirmed prediction
 * mismatches / confirmed bugs). That hand-work is exactly what spec-lantern
 * exists to make unnecessary: the predictions are already LOCKED on disk, and a
 * persisted execution result already holds the real Actual_Results. This tool
 * runs the EXISTING {@link comparePropertiesFromLocks Comparison Engine} against
 * a persisted result, reading each predicted verdict ONLY from the locks (never
 * from the caller), and writes `<specRoot>/comparison.json`.
 *
 * TWO DISTINCT QUANTITIES. A LIE is a confirmed bug — a property whose actual
 * verdict is FAIL — regardless of whether the read-only prediction happened to
 * match it. A predicted-FAIL / actual-FAIL confirmed lying comment is still a
 * lie even though its prediction MATCHED. That is separate from a PREDICTION
 * MISMATCH, which is only the rows where the predicted verdict differs from the
 * actual one. The summary reports both: `lieCount` (confirmed bugs, grouped by
 * root cause) and `predictionMismatchCount` (rows with status
 * PREDICTION_MISMATCH).
 *
 * ROOT-CAUSE GROUPING. A single root-cause lie can make several downstream
 * properties fail as SYMPTOMS. Counting each symptom as its own "lie" overstates
 * the number of lies. When the caller supplies `rootCauses` (a map
 * `rootCausePropertyId → [symptomPropertyId, ...]`), each symptom's comparison
 * is grouped under its root cause and a confirmed bug is counted ONCE PER
 * ROOT CAUSE rather than once per symptom. Without `rootCauses`, every confirmed
 * bug is counted separately.
 *
 * HOST SAFETY & FIDELITY. This reads JSON (the persisted result, the locks) and
 * writes JSON (`comparison.json`); it executes nothing. Predicted verdicts come
 * from the locks, actuals come from the persisted result — nothing is invented.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parsePropertyTestFileName,
  type ActualResult,
  type PropertyComparison,
} from "@spec-lantern/types";
import {
  comparePropertiesFromLocks,
  type LockedComparisonInput,
} from "../comparison/index.js";
import type { LockTarget } from "../prediction-lock/index.js";

/* -------------------------------------------------------------------------- */
/* Request / result shapes                                                    */
/* -------------------------------------------------------------------------- */

/** The input to {@link comparePredictions} — the `compare_predictions` payload. */
export interface ComparePredictionsRequest {
  /** Spec root holding the locks and receiving `comparison.json`. */
  specRoot: string;
  /**
   * Path to a persisted execution result JSON (what `execute_properties` or
   * `apply_fixes_and_reexecute` wrote under `results/`). Its `ActualResult[]`
   * are read from `.results`, or from `.postFixExecution.results` for an
   * apply-fixes result.
   */
  resultsPath: string;
  /**
   * OPTIONAL root-cause → symptoms map. When present, symptom comparisons are
   * grouped under their root cause and a confirmed mismatch is counted once per
   * root cause rather than once per symptom.
   */
  rootCauses?: Record<string, string[]>;
}

/** A root cause with the symptom comparisons grouped beneath it. */
export interface RootCauseGroup {
  /** The root-cause property's own comparison, when it was executed. */
  rootCause: PropertyComparison | null;
  /** The root-cause property id (even when its own comparison is absent). */
  rootCausePropertyId: string;
  /** The symptom comparisons attributed to this root cause. */
  symptoms: PropertyComparison[];
  /**
   * Whether this root-cause group contains a lie: true when the root cause OR
   * any of its symptoms is a confirmed bug (actual FAIL), independent of whether
   * any prediction matched. Counts as ONE lie.
   */
  isLie: boolean;
}

/** The summary {@link comparePredictions} returns and persists. */
export interface ComparePredictionsSummary {
  /** One comparison per Actual_Result in the persisted result, in order. */
  comparisons: PropertyComparison[];
  /** Root-cause groups (empty when no `rootCauses` was given). */
  rootCauseGroups: RootCauseGroup[];
  /**
   * The number of LIES — confirmed bugs (actual FAIL) grouped by root cause. A
   * confirmed bug is a lie independent of whether its read-only prediction
   * matched (a predicted-FAIL / actual-FAIL row is still a lie). Without
   * `rootCauses`, one per confirmed-bug comparison. With `rootCauses`, one per
   * root-cause group that contains a confirmed bug PLUS any ungrouped confirmed
   * bug.
   */
  lieCount: number;
  /**
   * The number of PREDICTION MISMATCHES — comparisons whose status is
   * `PREDICTION_MISMATCH`, i.e. rows where the locked predicted verdict differs
   * from the actual verdict. This is the OLD meaning of `lieCount`; it is NOT
   * the lie count (a matched prediction on a confirmed bug is a lie but not a
   * mismatch).
   */
  predictionMismatchCount: number;
  /**
   * The number of confirmed bugs (actual FAIL), ungrouped — one per row with
   * `confirmedBug === true`, regardless of root-cause grouping.
   */
  confirmedBugCount: number;
}

/** The full result of {@link comparePredictions}. */
export interface ComparePredictionsResult extends ComparePredictionsSummary {
  /** Absolute path to the written `comparison.json`. */
  comparisonPath: string;
}

/* -------------------------------------------------------------------------- */
/* Reading the persisted result                                              */
/* -------------------------------------------------------------------------- */

/** True for an object that looks like an `ActualResult` (has a propertyId). */
function isActualResult(value: unknown): value is ActualResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { propertyId?: unknown }).propertyId === "string" &&
    typeof (value as { outcome?: unknown }).outcome === "string"
  );
}

/**
 * Extract the `ActualResult[]` from a persisted execution result. Accepts both
 * a {@link PropertyExecutionResult} (`.results`) and an apply-fixes result
 * (`.postFixExecution.results`). Throws a descriptive error when neither shape
 * is present (the tool handler turns it into a structured message).
 */
export function extractActualResults(parsed: unknown): ActualResult[] {
  const direct = (parsed as { results?: unknown }).results;
  if (Array.isArray(direct) && direct.every(isActualResult)) {
    return direct;
  }
  const postFix = (parsed as { postFixExecution?: { results?: unknown } })
    .postFixExecution?.results;
  if (Array.isArray(postFix) && postFix.every(isActualResult)) {
    return postFix;
  }
  throw new Error(
    "Persisted result has no readable ActualResult[] at `.results` or " +
      "`.postFixExecution.results`.",
  );
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run the Comparison Engine against a persisted execution result, reading
 * predicted verdicts from the LOCKS only, optionally grouping symptoms under
 * their root cause, and write `<specRoot>/comparison.json`.
 *
 * @throws if `resultsPath` cannot be read/parsed or has no ActualResult[].
 */
export async function comparePredictions(
  request: ComparePredictionsRequest,
): Promise<ComparePredictionsResult> {
  const { specRoot, resultsPath, rootCauses } = request;

  // 1. Read + parse the persisted execution result and extract the actuals.
  const raw = await readFile(resultsPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const actuals = extractActualResults(parsed);

  // 2. Build a LockTarget per actual from its propertyId, then compare using the
  //    LOCKS as the sole source of predicted verdicts (never the caller).
  const inputs: LockedComparisonInput[] = [];
  for (const actual of actuals) {
    const parsedId = parsePropertyTestFileName(`${actual.propertyId}.test.ts`);
    if (parsedId === null) {
      // A propertyId that does not follow the `property-{n}.{claimId}` stem has
      // no resolvable lock; compare with no prediction (null) via a lock target
      // that will simply miss. Build a best-effort target so the engine still
      // records the actual (predicted → null).
      inputs.push({
        lockTarget: { specRoot, claimId: actual.propertyId, propertyNumber: 0 },
        actual,
      });
      continue;
    }
    const lockTarget: LockTarget = {
      specRoot,
      claimId: parsedId.claimId,
      propertyNumber: parsedId.propertyNumber,
    };
    inputs.push({ lockTarget, actual });
  }

  const comparisons = await comparePropertiesFromLocks(inputs);

  // 3. Count three distinct quantities:
  //    - confirmedBugCount: every row that is a confirmed bug (actual FAIL).
  //    - predictionMismatchCount: every row whose locked prediction != actual.
  //    - lieCount: confirmed bugs grouped by root cause (a lie is a confirmed
  //      bug independent of whether its prediction matched).
  const byId = new Map<string, PropertyComparison>();
  for (const c of comparisons) byId.set(c.propertyId, c);
  const confirmedBugCount = comparisons.filter((c) => c.confirmedBug).length;
  const predictionMismatchCount = comparisons.filter(
    (c) => c.status === "PREDICTION_MISMATCH",
  ).length;

  // A row is a lie when it is a confirmed bug (actual FAIL) — NOT when the
  // prediction merely mismatched.
  const isLie = (c: PropertyComparison | undefined): boolean =>
    c?.confirmedBug === true;

  const { rootCauseGroups, lieCount } = rootCauses
    ? groupByRootCause(comparisons, byId, rootCauses, isLie)
    : {
        rootCauseGroups: [] as RootCauseGroup[],
        lieCount: comparisons.filter((c) => isLie(c)).length,
      };

  const summary: ComparePredictionsSummary = {
    comparisons,
    rootCauseGroups,
    lieCount,
    predictionMismatchCount,
    confirmedBugCount,
  };

  // 4. Persist comparison.json verbatim.
  const comparisonPath = resolve(specRoot, "comparison.json");
  await writeFile(
    comparisonPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  return { ...summary, comparisonPath };
}

/**
 * Group symptom comparisons under their root cause and count a lie ONCE PER
 * root-cause group (the group is a lie when the root cause or any symptom is a
 * confirmed bug, per `isLie`), plus any confirmed bug that belongs to no group.
 */
function groupByRootCause(
  comparisons: PropertyComparison[],
  byId: Map<string, PropertyComparison>,
  rootCauses: Record<string, string[]>,
  isLie: (c: PropertyComparison | undefined) => boolean,
): { rootCauseGroups: RootCauseGroup[]; lieCount: number } {
  const grouped = new Set<string>();
  const rootCauseGroups: RootCauseGroup[] = [];
  let lieCount = 0;

  for (const [rootCausePropertyId, symptomIds] of Object.entries(rootCauses)) {
    const rootCause = byId.get(rootCausePropertyId) ?? null;
    grouped.add(rootCausePropertyId);
    const symptoms: PropertyComparison[] = [];
    for (const symptomId of symptomIds) {
      const symptom = byId.get(symptomId);
      grouped.add(symptomId);
      if (symptom) symptoms.push(symptom);
    }
    const groupIsLie =
      isLie(rootCause ?? undefined) || symptoms.some((s) => isLie(s));
    if (groupIsLie) lieCount += 1;
    rootCauseGroups.push({
      rootCause,
      rootCausePropertyId,
      symptoms,
      isLie: groupIsLie,
    });
  }

  // Any confirmed bug NOT part of a root-cause group counts on its own.
  for (const c of comparisons) {
    if (!grouped.has(c.propertyId) && isLie(c)) lieCount += 1;
  }

  return { rootCauseGroups, lieCount };
}
