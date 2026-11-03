/**
 * @spec-lantern/ui — Lantern_Report_UI components (tasks 18.1, 18.2).
 *
 * These components render a {@link LanternReport} (or just its
 * {@link PropertyComparison}[] rows) as a table of Correctness_Property rows.
 * They are PURE and PROPS-DRIVEN: every value shown comes from props, nothing
 * is fetched, and nothing touches the host. The same views back both the
 * interactive UI and the runnable demo (packages/ui/index.html).
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
 * Design language (the "lantern" theme in ./lantern-theme.css):
 *   - The lying Claim is the HERO of each row: the original code comment is
 *     quoted as a headline with its source location, above a human-readable
 *     title; the propertyId slug is small secondary text.
 *   - Predicted_Result is a translucent "ghost"; Actual_Result is crisp. The
 *     per-cell labels are gone — the column headers ("Kiro believed",
 *     "Execution proved") carry that meaning.
 *   - Only mismatch rows glow amber; the mismatch is an ICON + LABEL ("Lie
 *     exposed"), never colour alone (WCAG). Matching rows show a muted "✓ Match".
 *   - A Counterexample is a large "evidence" card: a side-by-side
 *     Expected-vs-Actual contrast, with the raw input/output JSON tucked into a
 *     collapsible "Raw details".
 *   - A Property_Transition reads tombstone → lit lantern, labeled "Revived".
 *   - The header tallies "N claims checked · N lie(s) exposed · N revived".
 * All colour/motion lives in the stylesheet; `prefers-reduced-motion` is
 * honoured there. These components only attach semantic class names + testids.
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
  match: (propertyId: string) => `match-indicator-${propertyId}`,
  claim: (propertyId: string) => `claim-${propertyId}`,
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
  // Design header tally + subheader.
  summary: "lantern-summary",
  subheader: "lantern-subheader",
  sampleBadge: "lantern-sample-badge",
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

/** An Expected-vs-Actual pair extracted from a Counterexample's output. */
export interface ExpectedActual {
  expected: string;
  actual: string;
}

/**
 * Best-effort extraction of a short Expected-vs-Actual contrast from a
 * Counterexample's `observedOutput` (which is `unknown`, R5.6), for the large
 * side-by-side headline in the evidence card. Recognises the common shapes a
 * reverse-engineered property records — `{ expectedFirstRow, actualFirstRow }`
 * and the generic `{ expected, actual }` — and returns `null` otherwise so the
 * card falls back to showing only the raw details. Never throws.
 */
export function extractExpectedActual(output: unknown): ExpectedActual | null {
  if (output === null || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["expectedFirstRow", "actualFirstRow"],
    ["expected", "actual"],
  ];
  for (const [ek, ak] of pairs) {
    if (ek in o && ak in o) {
      return { expected: safeStringify(o[ek]), actual: safeStringify(o[ak]) };
    }
  }
  return null;
}

/**
 * The header tally: how many claims were checked, how many "lies" were exposed
 * (Confirmed_Bugs — a prediction the execution disproved), and how many were
 * Revived (a Property_Transition that ended PASS). Derived purely from the
 * comparisons.
 */
export interface ReportSummary {
  checked: number;
  exposed: number;
  revived: number;
}

export function summarize(
  comparisons: readonly PropertyComparison[],
): ReportSummary {
  let exposed = 0;
  let revived = 0;
  for (const c of comparisons) {
    if (c.confirmedBug) exposed += 1;
    if (c.transition && c.transition.postFixResult === "PASS") revived += 1;
  }
  return { checked: comparisons.length, exposed, revived };
}

/* -------------------------------------------------------------------------- */
/* ClaimHero                                                                  */
/* -------------------------------------------------------------------------- */

/** Props for {@link ClaimHero}. */
export interface ClaimHeroProps {
  /** The comparison whose Claim + title to headline. */
  comparison: PropertyComparison;
}

/**
 * The hero of a row: the lying Claim. Renders the original code comment as a
 * quoted headline with its source location (e.g. "Reverse to have most recent
 * month first" — PeriodProgressSummary.tsx:54), a human-readable title beneath
 * it, and the propertyId slug as small secondary text.
 *
 * Everything but the slug comes from the optional `display` metadata; a
 * comparison with no `display` still renders (the title falls back to the slug,
 * and the quoted comment/source simply don't appear), so producers that don't
 * populate `display` are unaffected.
 */
export function ClaimHero({ comparison }: ClaimHeroProps): ReactElement {
  const { propertyId, display } = comparison;
  const title = display?.title ?? propertyId;
  const claimText = display?.claimText;
  const sourceLocation = display?.sourceLocation;

  return (
    <div className="lantern-claim" data-testid={TEST_IDS.claim(propertyId)}>
      {claimText ? (
        <p className="lantern-claim__quote">
          <span className="lantern-claim__comment">“{claimText}”</span>
          {sourceLocation ? (
            <span className="lantern-claim__source"> — {sourceLocation}</span>
          ) : null}
        </p>
      ) : null}
      <h2 className="lantern-claim__title">{title}</h2>
      <p className="lantern-claim__slug">{propertyId}</p>
    </div>
  );
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
 * Layout: the Claim hero (id/title/quoted comment), then the predicted cell
 * IMMEDIATELY FOLLOWED BY the actual cell (adjacent, same row — R10.1), then a
 * status cell that holds the mismatch indicator when {@link isMismatch} is true
 * (R10.3) and a muted "✓ Match" otherwise. The indicator's `data-testid` makes
 * presence/absence assertable.
 *
 * Design: predicted is the translucent "ghost", actual is crisp; the per-cell
 * labels are dropped in favour of the column headers. A mismatched row carries
 * `data-mismatch` so the stylesheet can make ONLY that row glow amber. The
 * mismatch indicator is an icon + text label, never colour alone (WCAG).
 */
export function PropertyRow({ comparison }: PropertyRowProps): ReactElement {
  const { propertyId } = comparison;
  const mismatch = isMismatch(comparison);

  return (
    <tr
      className="lantern-row"
      data-testid={TEST_IDS.row(propertyId)}
      data-status={comparison.status}
      data-mismatch={mismatch ? "true" : undefined}
    >
      <td className="lantern-cell lantern-cell--claim">
        <ClaimHero comparison={comparison} />
      </td>
      {/* R10.1: predicted and actual are adjacent cells in this one row. */}
      <td
        className="lantern-cell lantern-cell--predicted"
        data-testid={TEST_IDS.predicted(propertyId)}
        data-field="predicted"
      >
        <span className="lantern-verdict lantern-verdict--ghost">
          {formatPredicted(comparison.predicted)}
        </span>
      </td>
      <td
        className="lantern-cell lantern-cell--actual"
        data-testid={TEST_IDS.actual(propertyId)}
        data-field="actual"
      >
        <span className="lantern-verdict lantern-verdict--crisp">
          {formatActual(comparison.actual)}
        </span>
      </td>
      <td className="lantern-cell lantern-cell--status" data-field="status">
        {/* R10.3: mismatch indicator present EXACTLY on mismatched rows; a muted
            "✓ Match" otherwise. Icon + label, not colour alone (WCAG). */}
        {mismatch ? (
          <span
            className="lantern-mismatch"
            data-testid={TEST_IDS.mismatch(propertyId)}
            role="img"
            aria-label="predicted/actual mismatch — lie exposed"
            title="Predicted differs from actual"
          >
            <span className="lantern-mismatch__icon" aria-hidden="true">
              ⚠
            </span>
            <span className="lantern-mismatch__label">Lie exposed</span>
          </span>
        ) : (
          <span
            className="lantern-match"
            data-testid={TEST_IDS.match(propertyId)}
            role="img"
            aria-label="predicted matches actual"
          >
            <span className="lantern-match__icon" aria-hidden="true">
              ✓
            </span>
            <span className="lantern-match__label">Match</span>
          </span>
        )}
      </td>
      {/* Task 18.2: Counterexample / unavailable (R10.4, R10.6) and
          Property_Transition (R10.5) detail for this same row. */}
      <td className="lantern-cell lantern-cell--detail" data-field="detail">
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
 *   - Confirmed_Bug + Counterexample -> render the evidence card (R10.4).
 *   - Confirmed_Bug + none           -> render the unavailable indication (R10.6).
 *
 * Design: the card leads with a large Expected-vs-Actual contrast (when the
 * output exposes one — {@link extractExpectedActual}), and tucks the raw
 * input/output JSON into a collapsible "Raw details" so the headline stays
 * clean. The `unknown` values go through {@link safeStringify} and never render
 * as a raw object.
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
        className="lantern-evidence lantern-evidence--unavailable"
        data-testid={TEST_IDS.counterexampleUnavailable(propertyId)}
        data-field="counterexample-unavailable"
      >
        Counterexample unavailable
      </div>
    );
  }

  const contrast = extractExpectedActual(counterexample.observedOutput);

  // R10.4: show the triggering input/state and the observed output.
  return (
    <div
      className="lantern-evidence"
      data-testid={TEST_IDS.counterexample(propertyId)}
      data-field="counterexample"
    >
      <div className="lantern-evidence__title">Evidence</div>
      {contrast ? (
        <div className="lantern-contrast">
          <div className="lantern-contrast__side lantern-contrast__side--expected">
            <span className="lantern-contrast__label">Expected</span>
            <span className="lantern-contrast__value">{contrast.expected}</span>
          </div>
          <div className="lantern-contrast__vs" aria-hidden="true">
            vs
          </div>
          <div className="lantern-contrast__side lantern-contrast__side--actual">
            <span className="lantern-contrast__label">Actual</span>
            <span className="lantern-contrast__value">{contrast.actual}</span>
          </div>
        </div>
      ) : null}
      <details className="lantern-raw">
        <summary className="lantern-raw__summary">Raw details</summary>
        <div
          className="lantern-raw__row"
          data-testid={TEST_IDS.counterexampleInput(propertyId)}
        >
          <span className="lantern-raw__key" data-label="input">
            Input
          </span>
          <code className="lantern-raw__value">
            {safeStringify(counterexample.input)}
          </code>
        </div>
        <div
          className="lantern-raw__row"
          data-testid={TEST_IDS.counterexampleOutput(propertyId)}
        >
          <span className="lantern-raw__key" data-label="observed-output">
            Observed
          </span>
          <code className="lantern-raw__value">
            {safeStringify(counterexample.observedOutput)}
          </code>
        </div>
      </details>
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
 *
 * Design: the pre-fix state reads as a tombstone (the property was dead/failing)
 * and the post-fix state as a lit lantern, under the label "Revived". The
 * classification (FIXED / NOT_RESOLVED / REGRESSION / STILL_PASSING) is surfaced
 * as a `data-classification` attribute for callers that want to style the
 * pre→post pair; the pre/post VERDICT text is always present so the meaning
 * never relies on an emoji alone.
 */
export function TransitionDetail({
  comparison,
}: TransitionDetailProps): ReactElement | null {
  const { propertyId, transition } = comparison;
  if (!transition) return null;

  return (
    <div
      className="lantern-revived"
      data-testid={TEST_IDS.transition(propertyId)}
      data-field="transition"
      data-classification={transition.classification}
    >
      <span className="lantern-revived__label">Revived</span>
      <span
        className="lantern-revived__state lantern-revived__state--pre"
        data-testid={TEST_IDS.transitionPreFix(propertyId)}
      >
        <span className="lantern-revived__icon" aria-hidden="true">
          🪦
        </span>
        Pre-fix: {transition.preFixResult}
      </span>
      <span className="lantern-revived__arrow" aria-hidden="true">
        →
      </span>
      <span
        className="lantern-revived__state lantern-revived__state--post"
        data-testid={TEST_IDS.transitionPostFix(propertyId)}
      >
        <span className="lantern-revived__icon" aria-hidden="true">
          🏮
        </span>
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
    <table className="lantern-table" data-testid="property-table">
      <thead>
        <tr>
          <th scope="col">Claim</th>
          <th scope="col">Kiro believed</th>
          <th scope="col">Execution proved</th>
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
  /**
   * When true, render a small "Sample data" badge in the header to signal that
   * the report is hand-authored sample data, not real pipeline output. Set by
   * the demo (packages/ui/main.tsx) from `IS_SAMPLE_DATA`; removed once task 20
   * feeds the real Lantern_Report in. Defaults to false.
   */
  sampleData?: boolean;
}

/**
 * Top-level view for a {@link LanternReport} (tasks 18.1, 18.2).
 *
 * When a report is available, renders a header tally ("N claims checked · N
 * lie(s) exposed · N revived") and a target subheader above the property table.
 * When no report is available (`report` is `null`/`undefined`), renders the "no
 * report exists" message (R10.7) and no table. The nullish check is first so no
 * table code ever reads `report.comparisons` on an absent report.
 */
export function LanternReportView({
  report,
  sampleData = false,
}: LanternReportViewProps): ReactElement {
  // R10.7: no Lantern_Report available -> explicit "no report" message.
  if (report === null || report === undefined) {
    return (
      <section className="lantern" data-testid="lantern-report">
        <p className="lantern-empty" data-testid={TEST_IDS.noReport}>
          No report exists.
        </p>
      </section>
    );
  }

  const summary = summarize(report.comparisons);
  const checkedWord = summary.checked === 1 ? "claim checked" : "claims checked";
  const exposedWord = summary.exposed === 1 ? "lie exposed" : "lies exposed";

  return (
    <section className="lantern" data-testid="lantern-report">
      <header className="lantern-header">
        <h1 className="lantern-header__title">
          <span className="lantern-header__flame" aria-hidden="true">
            🏮
          </span>
          Lantern Report
          {sampleData ? (
            <span
              className="lantern-sample-badge"
              data-testid={TEST_IDS.sampleBadge}
              title="Hand-authored sample data — replaced by real pipeline output (task 20)"
            >
              Sample data
            </span>
          ) : null}
        </h1>
        <p className="lantern-header__subheader" data-testid={TEST_IDS.subheader}>
          Target: writing-tracker (abandoned Lovable app)
        </p>
        <p className="lantern-header__summary" data-testid={TEST_IDS.summary}>
          {summary.checked} {checkedWord} ·{" "}
          <span className="lantern-header__exposed">
            {summary.exposed} {exposedWord}
          </span>{" "}
          · {summary.revived} revived
        </p>
      </header>
      <PropertyTable comparisons={report.comparisons} />
    </section>
  );
}
