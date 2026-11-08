/**
 * @spec-lantern/mcp-server — the Comparison Engine (task 14.1, design Component 4).
 *
 * PURE LOGIC. This module pairs each property's Predicted_Result — the PASS/FAIL
 * Kiro recorded by READING the code, read back from the tamper-evident lock
 * (task 7) so comparison uses the ORIGINALLY recorded value and never one edited
 * to match what execution found (R3.5) — with its Actual_Result from the runner,
 * and classifies the pairing. It is the core of "execute, don't trust": a
 * {@link PropertyComparison} per property that makes a `PREDICTION_MISMATCH`
 * visible exactly where the read-only prediction disagreed with real execution.
 *
 * It does NOT execute anything, touch the host, or build the full Lantern_Report
 * (that is task 16). Given the predicted verdicts and the actual results, it
 * produces one {@link PropertyComparison} per property. Because it is pure, a
 * test can drive it directly with hand-built inputs; the lock-reading convenience
 * ({@link comparePropertiesFromLocks}) layers the task-7 lock reader on top for
 * callers that have on-disk locks rather than in-memory predicted verdicts.
 *
 * CLASSIFICATION RULES (R7.1–R7.5), applied per property:
 *
 *   actual outcome        | predicted | status                | confirmedBug
 *   ----------------------|-----------|-----------------------|-------------
 *   VERDICT (PASS/FAIL)   | PASS/FAIL | MATCH if equal,       | true iff
 *                         |           | else PREDICTION_      | actual
 *                         |           | MISMATCH (R7.1,R7.2)  | verdict FAIL
 *                         |           |                       | (R7.3)
 *   VERDICT (PASS/FAIL)   | null      | NO_LOCKED_PREDICTION  | true iff
 *                         |           | (nothing to compare;  | actual
 *                         |           | shown as "no locked   | verdict FAIL
 *                         |           | prediction", NEVER as | (R7.3)
 *                         |           | a pass; not a lie)    |
 *   TIMEOUT               | any       | NOT_COMPARED_TIMEOUT  | false
 *                         |           | (R7.4)                |
 *   EXECUTION_ERROR /     | any       | NOT_EXECUTED (R7.5:   | false
 *   RUNNER_UNAVAILABLE /  |           | no PASS/FAIL actual   |
 *   SAFETY_VIOLATION      |           | result exists)        |
 *   (no actual at all)    | PASS/FAIL | NOT_EXECUTED (R7.5)   | false
 *
 * Key invariants this encodes:
 *  - Only an actual `VERDICT` of exactly PASS or FAIL can pair for a mismatch or
 *    confirm a bug. Timeouts and execution errors are DISTINCT outcomes that are
 *    never PASS/FAIL (enforced by the `ActualResult` union in
 *    `@spec-lantern/types`), so they can never be a mismatch or a Confirmed_Bug.
 *  - `PREDICTION_MISMATCH` is flagged EXACTLY when a predicted PASS/FAIL and an
 *    actual PASS/FAIL hold unequal values (R7.2) — not when either is absent.
 *  - `confirmedBug` is true ONLY when the actual verdict is FAIL (R7.3), and the
 *    FAIL's Counterexample (when the runner returned one) rides on the
 *    comparison's `actual` result unchanged, so the report can surface it.
 *  - A timeout is NOT_COMPARED_TIMEOUT and is excluded from both mismatch
 *    flagging and Confirmed_Bug classification (R7.4).
 *  - A property with a recorded prediction but no PASS/FAIL actual result is
 *    NOT_EXECUTED and is neither paired as a mismatch nor confirmed as a bug
 *    (R7.5).
 *
 * The optional Property_Transition on a {@link PropertyComparison} is produced by
 * the Revive loop (task 15); this engine passes a supplied transition through
 * untouched and never fabricates one.
 *
 * Requirements traceability: 7.1, 7.2, 7.3, 7.4, 7.5.
 */
import type {
  ActualResult,
  PropertyComparison,
  PropertyTransition,
  Verdict,
} from "@spec-lantern/types";
import {
  readLockedVerdict,
  type LockTarget,
} from "../prediction-lock/index.js";

/* -------------------------------------------------------------------------- */
/* Input shape for pure comparison                                            */
/* -------------------------------------------------------------------------- */

/**
 * One property's inputs to the Comparison Engine: the LOCKED predicted verdict
 * (read back from the task-7 lock; `null` when no usable prediction was locked)
 * and the Actual_Result the runner produced for it.
 *
 * An optional {@link PropertyTransition} (from the Revive loop, task 15) is
 * carried through onto the resulting {@link PropertyComparison} unchanged — this
 * engine never classifies or fabricates a transition.
 */
export interface ComparisonInput {
  /** The property being compared (the `ActualResult.propertyId`). */
  propertyId: string;
  /**
   * The ORIGINALLY recorded Predicted_Result verdict, read from the lock
   * (R3.5). `null` when no prediction was locked for this property — then no
   * mismatch is possible, but a FAIL still confirms a bug (R7.3).
   */
  predicted: Verdict | null;
  /** The Actual_Result the Isolated_Runner produced for this property. */
  actual: ActualResult;
  /** Optional Revive-loop transition (task 15), passed through verbatim. */
  transition?: PropertyTransition;
}

/* -------------------------------------------------------------------------- */
/* Pure classification                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Narrow an {@link ActualResult} to the PASS/FAIL verdict it carries, or `null`
 * when it is a NON-verdict outcome (TIMEOUT / EXECUTION_ERROR /
 * RUNNER_UNAVAILABLE / SAFETY_VIOLATION). Only a `VERDICT` outcome holds a
 * PASS/FAIL value — this is where the union's guarantee that timeouts and errors
 * are never PASS/FAIL (R5.7, R5.9, R7.4) becomes the comparison's behavior.
 */
function actualVerdict(actual: ActualResult): Verdict | null {
  return actual.outcome === "VERDICT" ? actual.verdict : null;
}

/**
 * Compare ONE property: pair its locked Predicted_Result with its Actual_Result
 * and classify per R7.1–R7.5. Pure — no I/O, no execution.
 *
 * Decision order (each branch is exclusive):
 *  1. **Timeout → `NOT_COMPARED_TIMEOUT` (R7.4).** A timeout is excluded from
 *     mismatch flagging and Confirmed_Bug classification; it is explicitly
 *     "not compared". Checked FIRST so a timeout never falls through to the
 *     no-verdict NOT_EXECUTED branch — the two are distinct indications.
 *  2. **No PASS/FAIL actual verdict → `NOT_EXECUTED` (R7.5).** Any other
 *     non-`VERDICT` outcome (execution error, runner unavailable, safety
 *     violation) means no Actual_Result of PASS/FAIL exists, so the property is
 *     marked not executed and is neither paired as a mismatch nor confirmed as a
 *     bug. (A property with no actual result at all is represented by the caller
 *     synthesizing such an outcome; see {@link compareProperties}.)
 *  3. **A real PASS/FAIL actual verdict exists.** `confirmedBug` is true iff that
 *     verdict is FAIL (R7.3) — independent of the prediction — and the FAIL's
 *     Counterexample rides along on `actual`. Then:
 *       - If a predicted PASS/FAIL also exists, the pair is compared (R7.1):
 *         `MATCH` when equal, `PREDICTION_MISMATCH` when unequal (R7.2).
 *       - If no prediction was locked, there is nothing to compare against, so
 *         the status is `NO_LOCKED_PREDICTION` — rendered explicitly as "no
 *         locked prediction", never as a verified PASS/FAIL (no prediction is
 *         fabricated). The FAIL still confirms a bug, but such a row is never a
 *         prediction lie.
 *
 * @param input the property's locked prediction and actual result
 * @returns the classified {@link PropertyComparison}
 */
export function compareProperty(input: ComparisonInput): PropertyComparison {
  const { propertyId, predicted, actual, transition } = input;

  const base = {
    propertyId,
    predicted,
    actual,
    ...(transition ? { transition } : {}),
  };

  // 1. Timeout is excluded from comparison entirely (R7.4).
  if (actual.outcome === "TIMEOUT") {
    return {
      ...base,
      status: "NOT_COMPARED_TIMEOUT",
      confirmedBug: false,
    };
  }

  const verdict = actualVerdict(actual);

  // 2. No PASS/FAIL actual result → not executed (R7.5). Covers
  //    EXECUTION_ERROR / RUNNER_UNAVAILABLE / SAFETY_VIOLATION (and any
  //    synthesized "no result" outcome the caller passed in).
  if (verdict === null) {
    return {
      ...base,
      status: "NOT_EXECUTED",
      confirmedBug: false,
    };
  }

  // 3. A real PASS/FAIL actual verdict exists.
  //    confirmedBug is true iff the actual verdict is FAIL (R7.3), regardless of
  //    the prediction; the Counterexample stays on `actual` for the report.
  const confirmedBug = verdict === "FAIL";

  if (predicted === null) {
    // No prediction was locked, so there is nothing to compare against. This is
    // NOT a verified PASS/FAIL and must never render as a plain MATCH that reads
    // as a pass — surface it explicitly as "no locked prediction". A FAIL actual
    // still confirms a bug (`confirmedBug`), but the absence of a prediction
    // means this row can never be a prediction lie.
    return { ...base, status: "NO_LOCKED_PREDICTION", confirmedBug };
  }

  // Pair predicted with actual (R7.1); flag inequality as a mismatch (R7.2).
  const status = predicted === verdict ? "MATCH" : "PREDICTION_MISMATCH";
  return { ...base, status, confirmedBug };
}

/**
 * Compare a BATCH of properties — the engine's primary entry point. Produces one
 * {@link PropertyComparison} per input, in input order, by applying
 * {@link compareProperty} to each.
 *
 * Callers that track a set of EXPECTED properties (e.g. every property that had a
 * locked prediction) but received no Actual_Result for some of them should
 * include those properties here with a synthesized non-`VERDICT` actual result
 * so they surface as `NOT_EXECUTED` (R7.5) rather than silently vanishing;
 * {@link noActualResult} builds that placeholder.
 *
 * @param inputs the per-property locked prediction + actual result pairs
 * @returns one classified comparison per input, in order
 */
export function compareProperties(
  inputs: readonly ComparisonInput[],
): PropertyComparison[] {
  return inputs.map(compareProperty);
}

/**
 * Build a placeholder {@link ActualResult} representing "no Actual_Result exists"
 * for a property that had a locked Predicted_Result but was never executed
 * (R7.5). Modeled as an `EXECUTION_ERROR` — a NON-verdict outcome — so
 * {@link compareProperty} classifies it as `NOT_EXECUTED` through the same path
 * as a real execution error, keeping a single, uniform not-executed branch.
 */
export function noActualResult(
  propertyId: string,
  reason = "no Actual_Result was produced for this property",
): ActualResult {
  return { propertyId, outcome: "EXECUTION_ERROR", reason };
}

/* -------------------------------------------------------------------------- */
/* Lock-reading convenience (reuses the task-7 prediction lock)               */
/* -------------------------------------------------------------------------- */

/**
 * A property to compare when predictions live in on-disk locks rather than
 * in-memory: the lock coordinates (so the task-7 reader can load the LOCKED
 * verdict, R3.5) plus the Actual_Result the runner produced and an optional
 * Revive-loop transition.
 */
export interface LockedComparisonInput {
  /** Lock coordinates for {@link readLockedVerdict} (spec root, claim, number). */
  lockTarget: LockTarget;
  /** The Actual_Result the Isolated_Runner produced for this property. */
  actual: ActualResult;
  /** Optional Revive-loop transition (task 15), passed through verbatim. */
  transition?: PropertyTransition;
}

/**
 * Compare a batch of properties whose predictions are stored in on-disk locks.
 *
 * For each input this reads the LOCKED Predicted_Result verdict via the task-7
 * {@link readLockedVerdict} — so comparison always uses the originally recorded
 * value, never a prediction file edited after locking (R3.5) — and then applies
 * the SAME pure {@link compareProperty} classification. A property whose lock is
 * missing/unreadable yields a `null` predicted verdict, so it is treated as "no
 * prediction to pair": a FAIL still confirms a bug (R7.3) but no mismatch is
 * flagged.
 *
 * This is the only part of the engine that performs I/O (reading locks); the
 * classification itself stays pure. It reuses the existing lock-reading
 * mechanism rather than re-deriving predicted verdicts.
 *
 * @param inputs lock coordinates + actual result per property
 * @returns one classified comparison per input, in order
 */
export async function comparePropertiesFromLocks(
  inputs: readonly LockedComparisonInput[],
): Promise<PropertyComparison[]> {
  const comparisons: PropertyComparison[] = [];
  for (const { lockTarget, actual, transition } of inputs) {
    const predicted = await readLockedVerdict(lockTarget);
    comparisons.push(
      compareProperty({
        propertyId: actual.propertyId,
        predicted,
        actual,
        transition,
      }),
    );
  }
  return comparisons;
}
