/**
 * @spec-lantern/ui — Lantern_Report_UI components (task 18.1).
 *
 * These components render a {@link LanternReport} (or just its
 * {@link PropertyComparison}[] rows) as a table of Correctness_Property rows.
 * They are PURE and PROPS-DRIVEN: every value shown comes from props, nothing
 * is fetched, and nothing touches the host. The same views back both the
 * interactive UI and the static Hosted_Demo (task 19).
 *
 * Task 18.1 scope — three requirements:
 *   - R10.1: each row places its Predicted_Result and Actual_Result ADJACENTLY
 *     within the SAME row (a predicted cell immediately followed by an actual
 *     cell). Both cells carry stable `data-testid`s so adjacency is assertable.
 *   - R10.2: all Correctness_Property entries render within the configured UI
 *     render limit (default 3s, from {@link DEFAULT_LIMITS.uiRenderLimitSeconds}
 *     — never a hard-coded number). Rendering is synchronous and O(rows), so the
 *     limit is a contract we expose ({@link getUiRenderLimitSeconds}) and that
 *     the timing test (task 18.4) measures against; we do not hard-code "3".
 *   - R10.3: a visual mismatch indicator appears EXACTLY on rows whose Predicted
 *     differs from Actual — i.e. `status === "PREDICTION_MISMATCH"` — and is
 *     ABSENT everywhere else (MATCH, NOT_COMPARED_TIMEOUT, NOT_EXECUTED). We rely
 *     on the `status` field the Comparison Engine (task 14) already computed
 *     rather than re-deriving the comparison here, so TIMEOUT / NOT_EXECUTED rows
 *     are never mis-flagged as mismatches.
 *
 * Task 18.2 scope — four more requirements, built on the 18.1 seams:
 *   - R10.4: where a Correctness_Property is a Confirmed_Bug, show its
 *     Counterexample (the triggering input/state and the observed output). The
 *     counterexample is pulled from `comparison.actual` only when the outcome is
 *     `VERDICT` and a `counterexample` is attached ({@link getCounterexample}).
 *   - R10.5: where a Property_Transition is recorded for a property, show its
 *     Pre_Fix_Result and Post_Fix_Result (from `comparison.transition`).
 *   - R10.6: if a property IS a Confirmed_Bug (`confirmedBug === true`) but no
 *     Counterexample is available, show an explicit "Counterexample unavailable"
 *     indication rather than silently omitting it.
 *   - R10.7: if no Lantern_Report is available at all, show a "no report exists"
 *     message. {@link LanternReportView} accepts `report: LanternReport | null |
 *     undefined` and branches on nullish to render that message; passing a real
 *     report keeps the 18.1 behavior unchanged.
 *
 * These extend the 18.1 seams: {@link PropertyRow} still renders one `<tr>` and
 * now hangs detail cells (counterexample / unavailable / transition) off that
 * same row, and {@link LanternReportView} still receives the whole report.
 *
 * `input` and `observedOutput` are `unknown` (R5.6), so they are serialized
 * defensively via {@link safeStringify} — never rendered as a raw object.
 *
 * Requirements traceability: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7.
 */
import type { ReactElement } from "react";
import {
  DEFAULT_LIMITS,
  type ActualResult,
  type Counterexample,
  type LanternReport,
  type LimitsConfig,
  type PropertyComparison,
  type Verdict,
} from "@spec-lantern/types";

/* -------------------------------------------------------------------------- */
/* data-testid conventions                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Stable `data-testid` builders so tests (18.3/18.4) can locate cells and the
 * mismatch indicator deterministically, and so adjacency (R10.1) is assertable
 * by DOM position rather than by text. Keyed by `propertyId` because it is the
 * 1:1 identifier of a Correctness_Property (and its comparison).
 */
export const TEST_IDS = {
  row: (propertyId: string) => `property-row-${propertyId}`,
  predicted: (propertyId: string) => `predicted-${propertyId}`,
  actual: (propertyId: string) => `actual-${propertyId}`,
  mismatch: (propertyId: string) => `mismatch-indicator-${propertyId}`,
  // Task 18.2 — Counterexample (R10.4) and its parts.
  counterexample: (propertyId: string) => `counterexample-${propertyId}`,
  counterexampleInput: (propertyId: string) =>
    `counterexample-input-${propertyId}`,
  counterexampleOutput: (propertyId: string) =>
    `counterexample-output-${propertyId}`,
  // Task 18.2 — "Counterexample unavailable" indication (R10.6).
  counterexampleUnavailable: (propertyId: string) =>
    `counterexample-unavailable-${propertyId}`,
  // Task 18.2 — Property_Transition (R10.5) and its pre/post-fix values.
  transition: (propertyId: string) => `transition-${propertyId}`,
  transitionPreFix: (propertyId: string) => `transition-pre-fix-${propertyId}`,
  transitionPostFix: (propertyId: string) =>
    `transition-post-fix-${propertyId}`,
  // Task 18.2 — the "no report exists" empty state (R10.7). Not keyed by a
  // property because there is no report (and so no properties) to key on.
  noReport: "lantern-no-report",
} as const;

/* -------------------------------------------------------------------------- */
/* Render limit (R10.2)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The configured UI render limit in seconds (R10.2), read from the passed
 * {@link LimitsConfig} and defaulting to {@link DEFAULT_LIMITS} — NEVER a
 * hard-coded constant. Exposed so the timing test (task 18.4) and any caller
 * can assert against whatever limit is configured rather than the literal 3.
 */
export function getUiRenderLimitSeconds(
  limits: LimitsConfig = DEFAULT_LIMITS,
): number {
  return limits.uiRenderLimitSeconds;
}

/* -------------------------------------------------------------------------- */
/* Presentation helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Human-readable text for a predicted verdict (or its absence). A
 * predicted-only-absent row (e.g. NOT_EXECUTED has a prediction but no actual,
 * NOT handled here) still renders a stable label so the predicted cell is never
 * empty.
 */
export function formatPredicted(predicted: Verdict | null): string {
  return predicted ?? "—";
}

/**
 * Human-readable text for an {@link ActualResult}. A `VERDICT` renders as its
 * PASS/FAIL value; every non-verdict outcome renders as its outcome name so a
 * timeout or error is never mislabeled as PASS/FAIL (the same distinction the
 * closed `ActualResult` union enforces, R5.7/R5.9).
 */
export function formatActual(actual: ActualResult): string {
  return actual.outcome === "VERDICT" ? actual.verdict : actual.outcome;
}

/**
 * Whether a row must show the mismatch indicator (R10.3). True EXACTLY when the
 * Comparison Engine classified the row as a prediction mismatch. We trust the
 * precomputed `status` instead of re-comparing predicted vs actual so that
 * TIMEOUT (NOT_COMPARED_TIMEOUT) and predicted-only (NOT_EXECUTED) rows — where
 * no PASS/FAIL comparison was made — are never flagged.
 */
export function isMismatch(comparison: PropertyComparison): boolean {
  return comparison.status === "PREDICTION_MISMATCH";
}

/**
 * The {@link Counterexample} to display for a comparison (R10.4), or `null` when
 * none is available. A counterexample exists ONLY when the actual outcome is a
 * `VERDICT` carrying one — a TIMEOUT / EXECUTION_ERROR / RUNNER_UNAVAILABLE /
 * SAFETY_VIOLATION row never has one, and neither does a passing VERDICT. We
 * read it off `comparison.actual` rather than re-deriving it so the UI shows
 * exactly what execution recorded.
 */
export function getCounterexample(
  comparison: PropertyComparison,
): Counterexample | null {
  const { actual } = comparison;
  if (actual.outcome === "VERDICT" && actual.counterexample) {
    return actual.counterexample;
  }
  return null;
}

/**
 * Serialize an `unknown` Counterexample value (`input` / `observedOutput`, which
 * are `unknown` per R5.6) to a stable, human-readable string. Objects/arrays are
 * JSON-stringified; primitives render via `String`. A value that cannot be
 * serialized (e.g. a circular structure) falls back to its `String` form rather
 * than throwing, so a row always renders.
 */
export function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* -------------------------------------------------------------------------- */
/* PropertyRow                                                                */
/* -------------------------------------------------------------------------- */

/** Props for {@link PropertyRow}. */
export interface PropertyRowProps {
  /** The per-property comparison to render (predicted + actual + status). */
  comparison: PropertyComparison;
}

/**
 * Render one Correctness_Property as a table row (R10.1, R10.3).
 *
 * Layout: an id cell, then the predicted cell IMMEDIATELY FOLLOWED BY the actual
 * cell (adjacent, same row — R10.1), then a status cell that holds the mismatch
 * indicator only when {@link isMismatch} is true (R10.3). A row that matches
 * renders no indicator element at all, so tests can assert presence/absence by
 * the indicator's `data-testid`.
 *
 * This is the extension seam for task 18.2 — additional detail cells
 * (Counterexample, Property_Transition) will hang off this same row.
 */
export function PropertyRow({ comparison }: PropertyRowProps): ReactElement {
  const { propertyId } = comparison;
  const mismatch = isMismatch(comparison);

  return (
    <tr data-testid={TEST_IDS.row(propertyId)} data-status={comparison.status}>
      <td data-testid={`property-id-${propertyId}`}>{propertyId}</td>
      {/* R10.1: predicted and actual are adjacent cells in this one row. */}
      <td data-testid={TEST_IDS.predicted(propertyId)} data-field="predicted">
        {formatPredicted(comparison.predicted)}
      </td>
      <td data-testid={TEST_IDS.actual(propertyId)} data-field="actual">
        {formatActual(comparison.actual)}
      </td>
      <td data-field="status">
        {/* R10.3: indicator present EXACTLY on mismatched rows, absent otherwise. */}
        {mismatch ? (
          <span
            data-testid={TEST_IDS.mismatch(propertyId)}
            role="img"
            aria-label="predicted/actual mismatch"
            title="Predicted differs from actual"
          >
            ⚠︎ mismatch
          </span>
        ) : null}
      </td>
      {/* Task 18.2: Counterexample / unavailable (R10.4, R10.6) and
          Property_Transition (R10.5) detail for this same row. */}
      <td data-field="detail">
        <CounterexampleDetail comparison={comparison} />
        <TransitionDetail comparison={comparison} />
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* CounterexampleDetail (R10.4, R10.6)                                        */
/* -------------------------------------------------------------------------- */

/** Props for {@link CounterexampleDetail}. */
export interface CounterexampleDetailProps {
  /** The comparison whose Confirmed_Bug Counterexample (if any) to render. */
  comparison: PropertyComparison;
}

/**
 * Render Counterexample detail for a Confirmed_Bug row (R10.4), or an explicit
 * "unavailable" indication when the property is a Confirmed_Bug but carries no
 * Counterexample (R10.6).
 *
 * Decision table (keyed off {@link PropertyComparison.confirmedBug} and
 * {@link getCounterexample}):
 *   - not a Confirmed_Bug            -> render nothing (no detail is owed).
 *   - Confirmed_Bug + Counterexample -> render input + observed output (R10.4).
 *   - Confirmed_Bug + none           -> render the unavailable indication (R10.6).
 *
 * The triggering `input` and `observedOutput` are `unknown`, so both go through
 * {@link safeStringify} and never render as a raw object.
 */
export function CounterexampleDetail({
  comparison,
}: CounterexampleDetailProps): ReactElement | null {
  const { propertyId, confirmedBug } = comparison;

  // Only a Confirmed_Bug owes any counterexample detail at all.
  if (!confirmedBug) return null;

  const counterexample = getCounterexample(comparison);

  // R10.6: Confirmed_Bug with no Counterexample -> explicit unavailable text.
  if (counterexample === null) {
    return (
      <div
        data-testid={TEST_IDS.counterexampleUnavailable(propertyId)}
        data-field="counterexample-unavailable"
      >
        Counterexample unavailable
      </div>
    );
  }

  // R10.4: show the triggering input/state and the observed output.
  return (
    <div
      data-testid={TEST_IDS.counterexample(propertyId)}
      data-field="counterexample"
    >
      <div data-testid={TEST_IDS.counterexampleInput(propertyId)}>
        <span data-label="input">Input: </span>
        <code>{safeStringify(counterexample.input)}</code>
      </div>
      <div data-testid={TEST_IDS.counterexampleOutput(propertyId)}>
        <span data-label="observed-output">Observed: </span>
        <code>{safeStringify(counterexample.observedOutput)}</code>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* TransitionDetail (R10.5)                                                   */
/* -------------------------------------------------------------------------- */

/** Props for {@link TransitionDetail}. */
export interface TransitionDetailProps {
  /** The comparison whose Property_Transition (if any) to render. */
  comparison: PropertyComparison;
}

/**
 * Render the Pre_Fix_Result and Post_Fix_Result for a property that has a
 * recorded Property_Transition (R10.5), or nothing when no transition exists.
 * The transition's classification (FIXED / NOT_RESOLVED / REGRESSION /
 * STILL_PASSING) is surfaced as a `data-classification` attribute for callers
 * that want to style the pre→post pair.
 */
export function TransitionDetail({
  comparison,
}: TransitionDetailProps): ReactElement | null {
  const { propertyId, transition } = comparison;
  if (!transition) return null;

  return (
    <div
      data-testid={TEST_IDS.transition(propertyId)}
      data-field="transition"
      data-classification={transition.classification}
    >
      <span data-testid={TEST_IDS.transitionPreFix(propertyId)}>
        Pre-fix: {transition.preFixResult}
      </span>
      {" → "}
      <span data-testid={TEST_IDS.transitionPostFix(propertyId)}>
        Post-fix: {transition.postFixResult}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* PropertyTable                                                              */
/* -------------------------------------------------------------------------- */

/** Props for {@link PropertyTable}. */
export interface PropertyTableProps {
  /** One comparison per evaluated property, rendered in order. */
  comparisons: readonly PropertyComparison[];
}

/**
 * Render the comparisons as a table — one {@link PropertyRow} per entry, in the
 * order given (R10.1, R10.2). Rendering is synchronous and linear in the number
 * of rows; the configured render limit (R10.2) is a timing contract measured by
 * task 18.4, not a hard-coded value here.
 */
export function PropertyTable({ comparisons }: PropertyTableProps): ReactElement {
  return (
    <table data-testid="property-table">
      <thead>
        <tr>
          <th scope="col">Property</th>
          <th scope="col">Predicted</th>
          <th scope="col">Actual</th>
          <th scope="col">Status</th>
          <th scope="col">Detail</th>
        </tr>
      </thead>
      <tbody>
        {comparisons.map((comparison) => (
          <PropertyRow key={comparison.propertyId} comparison={comparison} />
        ))}
      </tbody>
    </table>
  );
}

/* -------------------------------------------------------------------------- */
/* LanternReportView                                                          */
/* -------------------------------------------------------------------------- */

/** Props for {@link LanternReportView}. */
export interface LanternReportViewProps {
  /**
   * The report to render. Its `comparisons` drive the property table. When
   * `null`/`undefined` — i.e. no Lantern_Report is available — the "no report
   * exists" message is shown instead (R10.7). Passing a real report keeps the
   * 18.1 behavior unchanged.
   */
  report: LanternReport | null | undefined;
  /**
   * Tunable limits (R10.2 reads `uiRenderLimitSeconds` from here). Defaults to
   * {@link DEFAULT_LIMITS}. Threaded through now so 18.2/18.4 can use it without
   * changing the public prop shape.
   */
  limits?: LimitsConfig;
}

/**
 * Top-level view for a {@link LanternReport} (tasks 18.1, 18.2).
 *
 * When a report is available, renders the property table (predicted vs actual,
 * adjacent, with the mismatch indicator on mismatched rows, plus Counterexample
 * and Property_Transition detail per row). When no report is available
 * (`report` is `null`/`undefined`), renders the "no report exists" message
 * (R10.7) and no table. The nullish check is first so no table code ever reads
 * `report.comparisons` on an absent report.
 */
export function LanternReportView({
  report,
}: LanternReportViewProps): ReactElement {
  // R10.7: no Lantern_Report available -> explicit "no report" message.
  if (report === null || report === undefined) {
    return (
      <section data-testid="lantern-report">
        <p data-testid={TEST_IDS.noReport}>No report exists.</p>
      </section>
    );
  }

  return (
    <section data-testid="lantern-report">
      <PropertyTable comparisons={report.comparisons} />
    </section>
  );
}
