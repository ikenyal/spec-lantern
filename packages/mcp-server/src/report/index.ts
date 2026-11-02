/**
 * @spec-lantern/mcp-server — Lantern_Report assembly (task 16.1, design
 * Component 4, the Comparison Engine's companion).
 *
 * PURE LOGIC. This module is the final assembly step: given the per-property
 * {@link PropertyComparison}[] the Comparison Engine (task 14,
 * {@link ../comparison/index.ts}) already produced — each pairing a LOCKED
 * Predicted_Result with its Actual_Result and classifying the pairing — plus the
 * {@link ObservedDeviation}[] Kiro recorded during analysis (task 2.2 / R2), it
 * builds a single {@link LanternReport}. It does NOT execute anything, read a
 * lock, or touch the host; it only assembles what it is given into the report
 * shape the UI (task 18) and the static Hosted_Demo (task 19) render.
 *
 * The report is a faithful, minimal assembly of its inputs — it fabricates
 * nothing and drops nothing:
 *
 *   - **Exactly one comparison per evaluated property (R9.2).** The
 *     `comparisons` list is the input list, in order, unchanged. Each comparison
 *     already carries its Predicted_Result (`predicted`) and Actual_Result
 *     (`actual`), so "list each Correctness_Property with its Predicted_Result
 *     and its Actual_Result" is satisfied by preserving the list as-is — one
 *     entry per property the Comparison Engine evaluated.
 *   - **Counterexamples for Confirmed_Bugs ride along (R9.3).** A Confirmed_Bug
 *     is a comparison with `confirmedBug === true`; its Counterexample (when the
 *     runner produced one) lives on `comparison.actual` as the
 *     `VERDICT`-outcome's `counterexample`. Preserving `actual` verbatim
 *     preserves the Counterexample — the report never re-derives or strips it.
 *   - **Property_Transitions ride along (R9.5).** A recorded Property_Transition
 *     lives on `comparison.transition` (produced by the Revive loop, task 15),
 *     carrying `preFixResult` / `postFixResult`. Preserving the comparison
 *     preserves the transition.
 *   - **Observed_Deviations are listed (R9.4).** The `observedDeviations` list is
 *     the input list, in order, unchanged. Each {@link ObservedDeviation}
 *     already references its originating Claim (`claimId`), and the matching
 *     comparison in `comparisons` carries that property's predicted-vs-actual
 *     pair, so the UI can join the two to describe "how the Actual_Result
 *     differs from the Predicted_Result" WITHOUT this module inventing a new
 *     report field. {@link describeDeviation} exposes that join as a helper for
 *     any caller (or the UI) that wants the prose description directly, but the
 *     persisted `LanternReport.observedDeviations` keeps the shared
 *     `ObservedDeviation[]` shape (the design does not change the type).
 *   - **Explicit "none found" indications (R9.6, R9.7).** `noConfirmedBug` is
 *     true iff NO comparison has `confirmedBug === true`; `noObservedDeviation`
 *     is true iff the observed-deviation list is empty. These are set
 *     explicitly so the UI can render an unambiguous "no Confirmed_Bug" /
 *     "no Observed_Deviation" message rather than inferring emptiness.
 *
 * TIMING (R9.1). The report must be produced within the configured
 * report-generation limit (default 10s, read from {@link LimitsConfig}, NOT a
 * literal). Assembly is pure and effectively instantaneous, but the limit is a
 * real contract, so {@link assembleLanternReportTimed} MEASURES the wall-clock
 * generation duration against the configured limit and reports whether it was
 * met; {@link assembleLanternReport} is the plain entry point that returns just
 * the report. The limit is always taken from the passed `LimitsConfig`
 * (defaulting to `DEFAULT_LIMITS`) — never hard-coded — so a reconfigured
 * environment is honored. An injectable `now` clock makes the timing
 * deterministic for the timed unit test (task 16.3).
 *
 * Requirements traceability: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7.
 */
import {
  DEFAULT_LIMITS,
  type ActualResult,
  type Counterexample,
  type LanternReport,
  type LimitsConfig,
  type ObservedDeviation,
  type PropertyComparison,
  type Verdict,
} from "@spec-lantern/types";

/* -------------------------------------------------------------------------- */
/* Clock injection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A monotonic-enough wall clock, injectable for deterministic timing in tests.
 * `nowMs()` returns milliseconds for measuring the generation duration (R9.1);
 * `nowIso()` returns the ISO instant stamped onto `LanternReport.generatedAt`.
 * Defaults to the real `Date` clock.
 */
export interface ReportClock {
  /** Current time in milliseconds, used to measure generation duration. */
  nowMs(): number;
  /** Current instant as an ISO-8601 string, stamped on `generatedAt`. */
  nowIso(): string;
}

/** The real-wall-clock {@link ReportClock} used in production. */
export const SYSTEM_REPORT_CLOCK: ReportClock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/* -------------------------------------------------------------------------- */
/* Options + timed result                                                     */
/* -------------------------------------------------------------------------- */

/** Options for {@link assembleLanternReport} / {@link assembleLanternReportTimed}. */
export interface AssembleLanternReportOptions {
  /**
   * Tunable limits (R9.1 reads `reportGenerationLimitSeconds` from here, never a
   * literal). Defaults to {@link DEFAULT_LIMITS}.
   */
  limits?: LimitsConfig;
  /** Injectable clock for deterministic timing/timestamps. Defaults to the real clock. */
  clock?: ReportClock;
}

/**
 * The {@link LanternReport} plus the measured generation timing — the return of
 * {@link assembleLanternReportTimed}. `durationMs` is the wall-clock time the
 * assembly took; `limitSeconds` is the configured report-generation limit that
 * was in effect (R9.1, from {@link LimitsConfig}); `withinLimit` is true iff the
 * assembly completed within that limit. The timed unit test (task 16.3) asserts
 * `withinLimit` against the CONFIGURED limit rather than any hard-coded number.
 */
export interface TimedLanternReport {
  /** The assembled report. */
  report: LanternReport;
  /** Wall-clock milliseconds the assembly took. */
  durationMs: number;
  /** The configured report-generation limit in effect (seconds, R9.1). */
  limitSeconds: number;
  /** True iff `durationMs` is within `limitSeconds` (R9.1). */
  withinLimit: boolean;
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Narrow a {@link PropertyComparison} to its Confirmed_Bug status (R9.3, R9.6):
 * a comparison is a Confirmed_Bug exactly when `confirmedBug === true`, which the
 * Comparison Engine sets only for an actual verdict of FAIL (R7.3).
 */
function isConfirmedBug(comparison: PropertyComparison): boolean {
  return comparison.confirmedBug === true;
}

/**
 * Extract the Counterexample a Confirmed_Bug comparison carries, if any (R9.3).
 * The Counterexample rides on the comparison's `actual` result — only a
 * `VERDICT` outcome can hold one — so this reads it off `actual` without
 * re-deriving it. Returns `undefined` when no Counterexample was produced (a
 * FAIL the runner could not minimize, which the UI surfaces as "unavailable",
 * R10.6).
 */
export function counterexampleOf(
  comparison: PropertyComparison,
): Counterexample | undefined {
  const actual: ActualResult = comparison.actual;
  return actual.outcome === "VERDICT" ? actual.counterexample : undefined;
}

/**
 * Human-readable rendering of an {@link ActualResult} for the predicted-vs-actual
 * description (R9.4). A `VERDICT` renders as its PASS/FAIL value; every other
 * (non-verdict) outcome renders as its outcome name so the description never
 * mislabels a timeout or error as PASS/FAIL (the same distinction the closed
 * `ActualResult` union enforces, R5.7, R5.9).
 */
function describeActual(actual: ActualResult): string {
  return actual.outcome === "VERDICT" ? actual.verdict : actual.outcome;
}

/** Human-readable rendering of a predicted verdict (or "no prediction"). */
function describePredicted(predicted: Verdict | null): string {
  return predicted ?? "no prediction";
}

/**
 * Describe, for an {@link ObservedDeviation}, how the Actual_Result differs from
 * the Predicted_Result of its associated Correctness_Property (R9.4).
 *
 * The association is by Claim: an Observed_Deviation references its originating
 * Claim via `claimId`, and that is the same id the Correctness_Property (and
 * therefore its {@link PropertyComparison}) is keyed on (the Claim→Property
 * mapping is 1:1, R3.1/R6.1). This joins the deviation to its comparison and
 * renders the predicted-vs-actual difference as prose. When no matching
 * comparison exists (the deviation's Claim was not executed as a property), the
 * description falls back to the deviation's own claimed-vs-current text so the
 * caller still gets a meaningful association. This is a READ-ONLY helper — it
 * does not mutate the report or the shared `ObservedDeviation` shape.
 *
 * @param deviation the Observed_Deviation to describe
 * @param comparisons the report's comparisons, to find the associated property
 * @returns a prose description of the predicted-vs-actual difference
 */
export function describeDeviation(
  deviation: ObservedDeviation,
  comparisons: readonly PropertyComparison[],
): string {
  const match = comparisons.find((c) => c.propertyId === deviation.claimId);
  if (match) {
    return (
      `Property ${match.propertyId}: predicted ` +
      `${describePredicted(match.predicted)}, actual ` +
      `${describeActual(match.actual)}.`
    );
  }
  const current = deviation.currentBehavior ?? "undeterminable";
  return (
    `Claim ${deviation.claimId}: claimed "${deviation.claimedBehavior}", ` +
    `current "${current}".`
  );
}

/**
 * Assemble a {@link LanternReport} from the Comparison Engine's output and the
 * recorded Observed_Deviations — the primary, pure entry point (task 16.1).
 *
 * The report lists exactly one comparison per evaluated property (R9.2), each
 * already carrying its Predicted_Result, Actual_Result, any Counterexample on a
 * Confirmed_Bug (R9.3), and any Property_Transition (R9.5); it lists the
 * Observed_Deviations as-is (R9.4, each joinable to its comparison by `claimId`
 * via {@link describeDeviation}); and it sets the explicit "none found"
 * indications `noConfirmedBug` (R9.6) and `noObservedDeviation` (R9.7).
 * `generatedAt` is stamped from the injectable clock.
 *
 * Pure and fast — no I/O, no execution, no host access. The inputs are copied
 * into fresh arrays so the returned report does not alias the caller's inputs.
 *
 * @param comparisons one comparison per evaluated property (Comparison Engine)
 * @param observedDeviations the Observed_Deviations recorded during analysis
 * @param options optional limits + injectable clock
 * @returns the assembled {@link LanternReport}
 */
export function assembleLanternReport(
  comparisons: readonly PropertyComparison[],
  observedDeviations: readonly ObservedDeviation[],
  options: AssembleLanternReportOptions = {},
): LanternReport {
  const clock = options.clock ?? SYSTEM_REPORT_CLOCK;

  // R9.6: no Confirmed_Bug iff no comparison is a Confirmed_Bug.
  const noConfirmedBug = !comparisons.some(isConfirmedBug);
  // R9.7: no Observed_Deviation iff the deviation list is empty.
  const noObservedDeviation = observedDeviations.length === 0;

  return {
    // R9.2: exactly one comparison per evaluated property, in order, unchanged
    // (each carries predicted + actual, and R9.3 Counterexamples / R9.5
    // transitions ride along on `actual` / `transition`).
    comparisons: [...comparisons],
    // R9.4: list the Observed_Deviations as given (joinable to their property).
    observedDeviations: [...observedDeviations],
    noConfirmedBug,
    noObservedDeviation,
    generatedAt: clock.nowIso(),
  };
}

/**
 * Assemble the report AND measure its generation against the configured
 * report-generation limit (R9.1).
 *
 * This wraps {@link assembleLanternReport}, bracketing it with the injectable
 * clock's `nowMs()` to measure the wall-clock duration, then compares that
 * duration to `limits.reportGenerationLimitSeconds` — read from the passed
 * {@link LimitsConfig} (defaulting to {@link DEFAULT_LIMITS}), NEVER a literal
 * constant — to decide `withinLimit`. Assembly is pure and effectively
 * instantaneous, so the measurement normally proves the limit with wide margin;
 * exposing the measured duration lets the timed unit test (task 16.3) verify the
 * contract deterministically against whatever limit is configured.
 *
 * @param comparisons one comparison per evaluated property
 * @param observedDeviations the Observed_Deviations recorded during analysis
 * @param options optional limits + injectable clock
 * @returns the report plus its measured timing against the configured limit
 */
export function assembleLanternReportTimed(
  comparisons: readonly PropertyComparison[],
  observedDeviations: readonly ObservedDeviation[],
  options: AssembleLanternReportOptions = {},
): TimedLanternReport {
  const clock = options.clock ?? SYSTEM_REPORT_CLOCK;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const limitSeconds = limits.reportGenerationLimitSeconds;

  const startMs = clock.nowMs();
  const report = assembleLanternReport(comparisons, observedDeviations, {
    ...options,
    clock,
  });
  const durationMs = clock.nowMs() - startMs;

  return {
    report,
    durationMs,
    limitSeconds,
    // R9.1: produced within the CONFIGURED limit (seconds → ms).
    withinLimit: durationMs <= limitSeconds * 1000,
  };
}
