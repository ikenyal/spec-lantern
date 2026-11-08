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
import type {
  HonestyItem,
  IsolationModel,
  LanternStory,
  ReportSectionsAsset,
  TargetTimeline,
} from "./report-asset.js";
import { formatUtc } from "./report-asset.js";

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
  symptom: (propertyId: string) => `symptom-indicator-${propertyId}`,
  match: (propertyId: string) => `match-indicator-${propertyId}`,
  claim: (propertyId: string) => `claim-${propertyId}`,
  claimNote: (propertyId: string) => `claim-note-${propertyId}`,
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
  // Headline story section (above the table).
  story: "lantern-story",
  storyThesis: "lantern-story-thesis",
  storySubhead: "lantern-story-subhead",
  storyStats: "lantern-story-stats",
  storyStep: (n: number) => `lantern-story-step-${n}`,
  storyMonths: "lantern-story-months",
  storyEvidence: "lantern-story-evidence",
  storyDiff: "lantern-story-diff",
  storySelection: "lantern-story-selection",
  storyCredit: "lantern-story-credit",
  // Three sections below the story, above the table (shared across targets).
  sections: "lantern-sections",
  timeline: "lantern-timeline",
  timelineStep: (phase: string) => `lantern-timeline-step-${phase}`,
  timelineLockedBefore: "lantern-timeline-locked-before",
  timelineVerdictsLocked: "lantern-timeline-verdicts-locked",
  timelineHarnessRevisions: "lantern-timeline-harness-revisions",
  timelineVerdictMismatch: "lantern-timeline-verdict-mismatch",
  isolation: "lantern-isolation",
  isolationPhase: (id: string) => `lantern-isolation-phase-${id}`,
  honesty: "lantern-honesty",
  honestyItem: (n: number) => `lantern-honesty-item-${n}`,
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
 * Patterns that extract an Expected-vs-Actual pair from a STRING
 * `observedOutput` — the shape fast-check records when a property's assertion
 * message is the counterexample. Ordered most-specific first. Each pattern
 * captures the expected value in group 1 and the actual value in group 2.
 *
 * The real writing-tracker counterexample is exactly this shape:
 *   "expected first row: Jan 2000, actual first row: Aug 1999: expected
 *    'Aug 1999' to be 'Jan 2000' // Object.is equality\n---\nError: ..."
 * so the `expected … first row: X, actual … first row: Y` pattern is what makes
 * the evidence card show "Expected Jan 2000 vs Actual Aug 1999" again.
 */
const STRING_CONTRAST_PATTERNS: readonly RegExp[] = [
  // "expected first row: <X>, actual first row: <Y>" (the real counterexample).
  /expected[^:]*\bfirst row:\s*(.+?),\s*actual[^:]*\bfirst row:\s*(.+?)(?::|$)/i,
  // Generic "expected <X> to be <Y>" (fast-check / chai default message).
  /expected\s+'?(.+?)'?\s+to be\s+'?(.+?)'?(?:\s*\/\/|$)/i,
];

/**
 * Best-effort extraction of a short Expected-vs-Actual contrast from a
 * Counterexample's `observedOutput` (which is `unknown`, R5.6), for the large
 * side-by-side headline in the evidence card.
 *
 * Handles both shapes a reverse-engineered property records:
 *   - an OBJECT exposing `{ expectedFirstRow, actualFirstRow }` or the generic
 *     `{ expected, actual }`, and
 *   - a STRING assertion message such as the real writing-tracker output
 *     "expected first row: Jan 2000, actual first row: Aug 1999: …", parsed via
 *     {@link STRING_CONTRAST_PATTERNS}.
 * Returns `null` when neither shape matches so the card falls back to showing
 * only the raw details. Never throws.
 */
export function extractExpectedActual(output: unknown): ExpectedActual | null {
  // STRING shape: the real fast-check counterexample message (bug #1).
  if (typeof output === "string") {
    for (const pattern of STRING_CONTRAST_PATTERNS) {
      const m = pattern.exec(output);
      if (m) {
        return { expected: m[1].trim(), actual: m[2].trim() };
      }
    }
    return null;
  }

  // OBJECT shape: a property that records the pair as structured fields.
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
 * Revived. Derived purely from the comparisons.
 *
 * Bug #2: "revived" counts ONLY properties whose Property_Transition is
 * classified `FIXED` (a FAIL→PASS revival). A property that was already passing
 * stays `STILL_PASSING` — it was never dead, so it was never revived and must
 * not inflate the tally. (The old code counted every transition that ended
 * PASS, which wrongly reported all three writing-tracker properties as
 * "revived" when only one was actually fixed.)
 */
export interface ReportSummary {
  checked: number;
  exposed: number;
  revived: number;
}

export function summarize(
  comparisons: readonly PropertyComparison[],
): ReportSummary {
  return { checked: comparisons.length, exposed: countLies(comparisons), revived: countRevived(comparisons) };
}

/**
 * The number of distinct LIES in a report: Confirmed_Bugs whose OWN comment is
 * the lie — i.e. excluding rows marked `display.symptomOf`, which are additional
 * symptoms of another row's root-cause lie, not separate lies. This is the
 * single source of truth for the lie count, used by {@link summarize} AND by a
 * story's stat line (via {@link formatLieCount}) so the UI can never show a
 * symptom as its own lie (e.g. MoodPlays must read "1 lie", not "2").
 */
export function countLies(comparisons: readonly PropertyComparison[]): number {
  let lies = 0;
  for (const c of comparisons) {
    if (c.confirmedBug && !c.display?.symptomOf) lies += 1;
  }
  return lies;
}

/** The number of revived properties: transitions classified FIXED (FAIL→PASS). */
export function countRevived(
  comparisons: readonly PropertyComparison[],
): number {
  let revived = 0;
  for (const c of comparisons) {
    if (c.transition && c.transition.classification === "FIXED") revived += 1;
  }
  return revived;
}

/** Render "N lie" / "N lies" for a lie count — the shared pluralization. */
export function formatLieCount(count: number): string {
  return `${count} ${count === 1 ? "lie" : "lies"}`;
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
      {display?.note ? (
        <p
          className="lantern-claim__note"
          data-testid={TEST_IDS.claimNote(propertyId)}
        >
          {display.note}
        </p>
      ) : null}
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
  // A mismatch row whose own comment is NOT the lie — it is a SYMPTOM of another
  // row's root-cause defect. Keep the row's factual data (mismatch styling,
  // counterexample, transition), but label it "Symptom of <…>" instead of
  // "Lie exposed" so one root-cause bug is not shown as multiple lies.
  const symptomOf = mismatch ? comparison.display?.symptomOf : undefined;

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
            "✓ Match" otherwise. Icon + label, not colour alone (WCAG). A
            mismatch that is a SYMPTOM of another row's root-cause lie shows a
            "Symptom of <…>" label instead of "Lie exposed". */}
        {mismatch ? (
          symptomOf ? (
            <span
              className="lantern-symptom"
              data-testid={TEST_IDS.symptom(propertyId)}
              role="img"
              aria-label={`predicted/actual mismatch — symptom of the ${symptomOf}; this comment itself holds`}
              title={`Symptom of the ${symptomOf}`}
            >
              <span className="lantern-symptom__icon" aria-hidden="true">
                ⤷
              </span>
              <span className="lantern-symptom__label">
                Symptom of the {symptomOf} — this comment itself holds
              </span>
            </span>
          ) : (
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
          )
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

  // Prefer an explicit, authored Expected-vs-Actual contrast (from the row's
  // display, traceable to the persisted Counterexample) over parsing the raw
  // observedOutput string, which for some properties is a fast-check assertion
  // message that does not read as a clean contrast.
  const contrast =
    comparison.display?.evidence ??
    extractExpectedActual(counterexample.observedOutput);

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
 * Design, keyed off the classification:
 *   - A true revival (`FIXED`, and likewise `NOT_RESOLVED` / `REGRESSION`,
 *     which also involve a dead or newly-broken property) reads tombstone → lit
 *     lantern under the label "Revived".
 *   - A `STILL_PASSING` property was never dead, so the tombstone→lantern visual
 *     would overstate what happened (bug #2). It shows a single muted line,
 *     "✓ Still passing after fix", with no Pre-fix/Post-fix detail.
 *
 * For a true revival the pre/post VERDICT text is present (surfaced via the
 * `transition-pre-fix` / `transition-post-fix` testids) so the meaning never
 * relies on an emoji or colour alone (WCAG). The classification is exposed as
 * `data-classification` for styling.
 */
export function TransitionDetail({
  comparison,
}: TransitionDetailProps): ReactElement | null {
  const { propertyId, transition } = comparison;
  if (!transition) return null;

  // Bug #2: a property that was already passing is NOT "revived". Show a single
  // muted line — "✓ Still passing after fix" — with no Pre-fix/Post-fix text,
  // never the tombstone→lantern revival visual.
  if (transition.classification === "STILL_PASSING") {
    return (
      <div
        className="lantern-still-passing"
        data-testid={TEST_IDS.transition(propertyId)}
        data-field="transition"
        data-classification={transition.classification}
      >
        <span className="lantern-still-passing__icon" aria-hidden="true">
          ✓
        </span>
        <span className="lantern-still-passing__label">
          Still passing after fix
        </span>
      </div>
    );
  }

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
/* StorySection                                                               */
/* -------------------------------------------------------------------------- */

/** Props for {@link StorySection}. */
export interface StorySectionProps {
  /** The headline story to render above the table. */
  story: LanternStory;
  /**
   * The lie count COMPUTED from the report ({@link countLies}). When the story's
   * `stats` text contains the token `{lies}`, it is substituted with
   * `formatLieCount(lieCount)` so the lie number is derived from the data, never
   * hand-written — the UI can never show "2 lies" when one row is a symptom.
   * A `stats` string with no `{lies}` token renders verbatim (writing-tracker).
   */
  lieCount?: number;
  /**
   * The number of claims checked (report comparisons). Together with `lieCount`
   * this substitutes the `{fooled}` token with "N/M" (lies / claims checked),
   * so a "Kiro fooled N/M" stat is computed, never hand-written.
   */
  checkedCount?: number;
}

/**
 * The headline story: the stat line plus a four-step narrative of the single
 * lead finding (predict → lock → execute → revive), shown above the property
 * table. The thesis sentence is NOT rendered here — {@link LanternReportView}
 * promotes it to the page headline.
 *
 * It renders ONLY values carried on the {@link LanternStory} — each a verbatim
 * copy of a persisted pipeline artifact (report-data-fidelity) — with ONE
 * derived exception: the lie count in the stat line is substituted from the
 * report via the `{lies}` token (see {@link StorySectionProps.lieCount}), so the
 * number is computed, not asserted.
 *
 * Accessibility: the monthly mock is a real `<table>` with a caption and scoped
 * headers; the current-month highlight is conveyed by a visible "(current
 * month)" label and an `aria-label`, never colour alone. Each step is a labeled
 * region; the diff is a `<pre>`.
 */
export function StorySection({
  story,
  lieCount,
  checkedCount,
}: StorySectionProps): ReactElement {
  const { comment, prediction, execution, revive } = story;
  // The month the claim PROMISED at the top — highlighted in the mock so a
  // viewer sees exactly where the current month ended up instead.
  const currentMonth = execution.expectedFirstRow;
  // Substitute the computed counts into the stat line's tokens. A stats string
  // without a token renders that part unchanged (writing-tracker has none).
  let statsText = story.stats;
  if (lieCount !== undefined) {
    statsText = statsText.replace("{lies}", formatLieCount(lieCount));
  }
  if (lieCount !== undefined && checkedCount !== undefined) {
    statsText = statsText.replace("{fooled}", `${lieCount}/${checkedCount}`);
  }

  return (
    <section
      className="lantern-story"
      data-testid={TEST_IDS.story}
      aria-label="Lead finding"
    >
      {/* The thesis is rendered as the page headline by LanternReportView; the
          story keeps only the stat line and the four steps. */}
      <p className="lantern-story__stats" data-testid={TEST_IDS.storyStats}>
        {statsText}
      </p>

      <ol className="lantern-story__steps">
        {/* Step 1 — the comment claimed … */}
        <li
          className="lantern-story__step"
          data-testid={TEST_IDS.storyStep(1)}
        >
          <span className="lantern-story__step-kicker">The comment said</span>
          <p className="lantern-story__step-body">
            <span className="lantern-story__comment">“{comment.claimText}”</span>{" "}
            <span className="lantern-story__source">
              — {comment.sourceLocation}
            </span>
          </p>
        </li>

        {/* Step 2 — Kiro read it and believed it. */}
        <li
          className="lantern-story__step"
          data-testid={TEST_IDS.storyStep(2)}
        >
          <span className="lantern-story__step-kicker">
            Kiro read the code and believed it
          </span>
          <p className="lantern-story__step-body">
            Predicted <strong>{prediction.verdict}</strong>, locked at{" "}
            <time dateTime={prediction.lockedAt}>{prediction.lockedAt}</time>{" "}
            before any execution{" "}
            <code className="lantern-story__hash">
              #{prediction.shortHash}
            </code>
            .
          </p>
        </li>

        {/* Step 3 — we ran it. */}
        <li
          className="lantern-story__step"
          data-testid={TEST_IDS.storyStep(3)}
        >
          <span className="lantern-story__step-kicker">We ran it</span>
          <p className="lantern-story__step-body">
            The real code ran in an isolated, network-less container with the
            clock at{" "}
            <time dateTime={execution.clock}>{execution.clock}</time> (
            {execution.timezone}).
            {execution.actualFirstRow && execution.expectedFirstRow ? (
              <>
                {" "}
                The first row was{" "}
                <strong>{execution.actualFirstRow}</strong>, not{" "}
                <strong>{execution.expectedFirstRow}</strong>.
              </>
            ) : null}
          </p>

          {/* Month-table mock — writing-tracker only (rendered when present). */}
          {execution.monthsAsRendered ? (
            <>
              <table
                className="lantern-story__months"
                data-testid={TEST_IDS.storyMonths}
              >
                <caption className="lantern-story__months-caption">
                  Monthly progress, as the current code renders it (top row
                  first)
                </caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Month</th>
                  </tr>
                </thead>
                <tbody>
                  {execution.monthsAsRendered.map((month, i) => {
                    const isCurrent = month === currentMonth;
                    return (
                      <tr
                        key={month}
                        className={
                          isCurrent
                            ? "lantern-story__month-row lantern-story__month-row--current"
                            : "lantern-story__month-row"
                        }
                        aria-label={
                          isCurrent
                            ? `${month} (current month — should be first, but renders last)`
                            : undefined
                        }
                      >
                        <td>{i + 1}</td>
                        <td>
                          {month}
                          {isCurrent ? (
                            <span className="lantern-story__month-tag">
                              {" "}
                              (current month)
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {/* report-data-fidelity: only the first row was directly observed
                  by execution (the counterexample); the rest of the ordering
                  follows deterministically from the same getPeriods() code path,
                  not from a separate observation. */}
              <p className="lantern-story__provenance">
                Row 1 observed in execution; the remaining order follows from the
                same code path.
              </p>
            </>
          ) : null}

          {/* Generic evidence lines — a story with no month-table mock (e.g.
              MoodPlays counterexamples). Each line is verbatim-sourced. */}
          {execution.evidenceLines ? (
            <ul
              className="lantern-story__evidence"
              data-testid={TEST_IDS.storyEvidence}
            >
              {execution.evidenceLines.map((line) => (
                <li key={line} className="lantern-story__evidence-line">
                  <code>{line}</code>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="lantern-story__impact">{execution.userImpact}</p>
        </li>

        {/* Step 4 — revived. */}
        <li
          className="lantern-story__step"
          data-testid={TEST_IDS.storyStep(4)}
        >
          <span className="lantern-story__step-kicker">Revived</span>
          <p className="lantern-story__step-body">
            <strong>{revive.preFixResult}</strong> →{" "}
            <strong>{revive.postFixResult}</strong>.{" "}
            {revive.otherClaimsStatus}
            {revive.reproducesSameFail
              ? " Reproducible via replay (reproducesSameFail: true)."
              : null}
          </p>
          <pre className="lantern-story__diff" data-testid={TEST_IDS.storyDiff}>
            <code>{revive.diff}</code>
          </pre>
        </li>
      </ol>

      {/* Optional "how this target was chosen" note + credit. */}
      {story.selection || story.credit ? (
        <footer className="lantern-story__footer">
          {story.selection ? (
            <p
              className="lantern-story__selection"
              data-testid={TEST_IDS.storySelection}
            >
              {story.selection.note}{" "}
              <span className="lantern-story__selection-doc">
                (see {story.selection.docPath})
              </span>
            </p>
          ) : null}
          {story.credit ? (
            <p
              className="lantern-story__credit"
              data-testid={TEST_IDS.storyCredit}
            >
              {story.credit}
            </p>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Behind the lantern — per-target timeline (section 1)                        */
/* -------------------------------------------------------------------------- */

/** Default GitHub blob base for linking a repo-relative file path. */
const DEFAULT_FILE_BASE =
  "https://github.com/ikenyal/spec-lantern/blob/main/";

/** Props for {@link BehindTheLanternSection}. */
export interface BehindTheLanternSectionProps {
  /** The per-target timeline to render (one target's steps). */
  timeline: TargetTimeline;
  /** Base URL for commit links (e.g. ".../commit/"). */
  commitBase: string;
  /**
   * GitHub blob base for resolving a repo-relative file path (the superseded
   * locks README link). Defaults to the canonical repo blob base.
   */
  fileBase?: string;
}

/**
 * Section 1 — "Behind the lantern": the ordered timeline for ONE target,
 * predictions locked → lock commit → execution → replay reproduced → fix →
 * regression check. Commit short hashes link to the exact commit on GitHub.
 *
 * The point it makes visible: the prediction lock timestamp PRECEDES the
 * execution timestamp — predictions were committed to git before any execution.
 * That flag (`predictionsLockedBeforeExecution`) is computed by the generator
 * from the real timestamps, and shown here as a callout.
 *
 * Accessibility: an ordered `<ol>` conveys sequence; each step's timestamp is a
 * `<time>` with a machine-readable `dateTime`; commit links carry descriptive
 * text (the hash + subject), never "click here". The "locked before execution"
 * callout is text, not colour alone.
 */
export function BehindTheLanternSection({
  timeline,
  commitBase,
  fileBase = DEFAULT_FILE_BASE,
}: BehindTheLanternSectionProps): ReactElement {
  const linkFor = (hash: string): string => `${commitBase}${hash}`;
  const harness = timeline.harnessRevisions;

  return (
    <section
      className="lantern-timeline"
      data-testid={TEST_IDS.timeline}
      aria-labelledby={`timeline-heading-${timeline.id}`}
    >
      <h3
        className="lantern-timeline__heading"
        id={`timeline-heading-${timeline.id}`}
      >
        Behind the lantern · {timeline.label}
      </h3>

      {/* The two statements are shown SEPARATELY and honestly: the predicted
          verdicts (locked before any execution) and the harness revisions
          (re-locks, verdicts unchanged, with their timing stated). */}
      <div
        className="lantern-timeline__locked-before"
        data-testid={TEST_IDS.timelineLockedBefore}
      >
        {timeline.predictionsLockedBeforeExecution ? (
          <p
            className="lantern-timeline__claim"
            data-testid={TEST_IDS.timelineVerdictsLocked}
          >
            <span className="lantern-timeline__locked-icon" aria-hidden="true">
              🔒
            </span>
            All predicted verdicts were locked before any execution.
          </p>
        ) : (
          <p
            className="lantern-timeline__claim"
            data-testid={TEST_IDS.timelineVerdictsLocked}
          >
            <span className="lantern-timeline__locked-icon" aria-hidden="true">
              ⚠
            </span>
            Not every predicted verdict was locked before execution.
          </p>
        )}

        {harness ? (
          <p
            className="lantern-timeline__harness"
            data-testid={TEST_IDS.timelineHarnessRevisions}
          >
            {harness.count} test{" "}
            {harness.count === 1 ? "harness was" : "harnesses were"} revised and
            re-locked (verdicts unchanged) — {harness.timingNote}.{" "}
            <a
              className="lantern-timeline__harness-link"
              href={`${fileBase}${harness.readmePath}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              superseded locks README
            </a>
          </p>
        ) : null}

        {timeline.verdictMismatches.length > 0 ? (
          <p
            className="lantern-timeline__mismatch"
            data-testid={TEST_IDS.timelineVerdictMismatch}
            role="alert"
          >
            <span aria-hidden="true">⚠ </span>
            {timeline.verdictMismatches.length} superseded lock
            {timeline.verdictMismatches.length === 1 ? "" : "s"} disagree with
            the active verdict:{" "}
            {timeline.verdictMismatches
              .map(
                (m) =>
                  `${m.propertyId} (active ${m.activeVerdict}, superseded ${m.supersededVerdict})`,
              )
              .join("; ")}
            .
          </p>
        ) : null}
      </div>

      <ol className="lantern-timeline__steps">
        {timeline.steps.map((step) => (
          <li
            key={step.phase}
            className="lantern-timeline__step"
            data-testid={TEST_IDS.timelineStep(step.phase)}
            data-phase={step.phase}
          >
            <span className="lantern-timeline__dot" aria-hidden="true" />
            <div className="lantern-timeline__step-body">
              <span className="lantern-timeline__step-label">{step.label}</span>
              {step.at ? (
                // Display normalized to one UTC format so the steps read in the
                // correct order; the raw value stays in the datetime attribute.
                <time
                  className="lantern-timeline__step-time"
                  dateTime={step.at}
                >
                  {formatUtc(step.at)}
                </time>
              ) : null}
              {step.detail ? (
                <span className="lantern-timeline__step-detail">
                  {step.detail}
                </span>
              ) : null}
              {step.commit ? (
                <a
                  className="lantern-timeline__commit"
                  href={linkFor(step.commit)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  commit {step.commit}
                  {step.commitSubject ? (
                    <span className="lantern-timeline__commit-subject">
                      {" "}
                      — {step.commitSubject}
                    </span>
                  ) : null}
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* How it stays safe — two-phase isolation diagram (section 2)                 */
/* -------------------------------------------------------------------------- */

/** Props for {@link HowItStaysSafeSection}. */
export interface HowItStaysSafeSectionProps {
  /** The two-phase isolation model (phases + cross-cutting guarantees). */
  isolation: IsolationModel;
}

/**
 * Section 2 — "How it stays safe": a small diagram of the two-phase isolation.
 * Each phase is a card listing the guarantees it enforces; cross-cutting
 * guarantees (Safety Gate, no host fallback, throwaway copy) follow. Every line
 * describes what the runner source actually does and is generated with a source
 * file reference (not shown as a link here, but carried in the data for audit).
 *
 * Accessibility: phases are a list of regions with headings; the arrow between
 * phases is `aria-hidden` decoration, and the ordering is also conveyed by the
 * "then" wording and the heading order, never by position alone.
 */
export function HowItStaysSafeSection({
  isolation,
}: HowItStaysSafeSectionProps): ReactElement {
  return (
    <section
      className="lantern-isolation"
      data-testid={TEST_IDS.isolation}
      aria-labelledby="isolation-heading"
    >
      <h3 className="lantern-isolation__heading" id="isolation-heading">
        How it stays safe
      </h3>
      <p className="lantern-isolation__intro">
        Target code runs only inside a two-phase isolated runner — never on the
        host.
      </p>

      <div className="lantern-isolation__phases">
        {isolation.phases.map((phase, i) => (
          <div key={phase.id} className="lantern-isolation__phase-wrap">
            {i > 0 ? (
              <span
                className="lantern-isolation__arrow"
                aria-hidden="true"
              >
                then →
              </span>
            ) : null}
            <div
              className="lantern-isolation__phase"
              data-testid={TEST_IDS.isolationPhase(phase.id)}
              data-phase={phase.id}
            >
              <h4 className="lantern-isolation__phase-title">{phase.title}</h4>
              <p className="lantern-isolation__phase-summary">
                {phase.summary}
              </p>
              <ul className="lantern-isolation__guarantees">
                {phase.guarantees.map((g) => (
                  <li key={g.text} className="lantern-isolation__guarantee">
                    {g.text}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>

      <div className="lantern-isolation__cross">
        <h4 className="lantern-isolation__cross-title">
          Across both phases
        </h4>
        <ul className="lantern-isolation__guarantees">
          {isolation.crossCutting.map((g) => (
            <li key={g.text} className="lantern-isolation__guarantee">
              {g.text}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* We hold ourselves to the same standard (section 3)                          */
/* -------------------------------------------------------------------------- */

/** Props for {@link SameStandardSection}. */
export interface SameStandardSectionProps {
  /** The self-accountability items (each links to its commit or file). */
  items: readonly HonestyItem[];
  /**
   * Base URL for GitHub blob links so a repo-relative file path resolves to a
   * viewable source link. A commit `href` (already absolute) is used as-is.
   */
  fileBase?: string;
}

/**
 * Section 3 — "We hold ourselves to the same standard": the episodes where
 * spec-lantern applied its own discipline to itself (the Safety Gate bypass its
 * property test caught, the writing-tracker harness defects it did NOT report
 * as bugs, and the MoodPlays tautological oracles it rewrote before executing).
 * Each item links to its commit (absolute URL) or its file (repo-relative path
 * resolved against a GitHub blob base).
 *
 * Accessibility: each item's link text is the commit hash or file path, so the
 * link is self-describing out of context.
 */
export function SameStandardSection({
  items,
  fileBase = DEFAULT_FILE_BASE,
}: SameStandardSectionProps): ReactElement {
  const hrefFor = (item: HonestyItem): string =>
    /^https?:\/\//.test(item.href) ? item.href : `${fileBase}${item.href}`;

  return (
    <section
      className="lantern-honesty"
      data-testid={TEST_IDS.honesty}
      aria-labelledby="honesty-heading"
    >
      <h3 className="lantern-honesty__heading" id="honesty-heading">
        We hold ourselves to the same standard
      </h3>
      <ul className="lantern-honesty__items">
        {items.map((item, i) => (
          <li
            key={item.title}
            className="lantern-honesty__item"
            data-testid={TEST_IDS.honestyItem(i)}
          >
            <p className="lantern-honesty__item-title">{item.title}</p>
            <p className="lantern-honesty__item-body">{item.body}</p>
            <a
              className="lantern-honesty__link"
              href={hrefFor(item)}
              target="_blank"
              rel="noreferrer noopener"
            >
              {item.linkLabel}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* ReportSections — the three sections, in order                               */
/* -------------------------------------------------------------------------- */

/** Props for {@link ReportSections}. */
export interface ReportSectionsProps {
  /** The build-time-generated sections asset. */
  sections: ReportSectionsAsset;
  /**
   * The id of the currently-shown target, so the per-target timeline renders
   * the matching one. When no timeline matches, the timeline is omitted (the
   * other two shared sections still render).
   */
  targetId?: string;
}

/**
 * Render the three sections — the per-target "Behind the lantern" timeline, the
 * shared "How it stays safe" isolation diagram, and the shared "We hold
 * ourselves to the same standard" items — in order. Shown between the story and
 * the property table. The isolation and honesty sections are shared across
 * targets; only the timeline is selected by `targetId`.
 */
export function ReportSections({
  sections,
  targetId,
}: ReportSectionsProps): ReactElement {
  const timeline =
    sections.timelines.find((t) => t.id === targetId) ??
    sections.timelines[0];

  return (
    <div className="lantern-sections" data-testid={TEST_IDS.sections}>
      {timeline ? (
        <BehindTheLanternSection
          timeline={timeline}
          commitBase={sections.commitBase}
        />
      ) : null}
      <HowItStaysSafeSection isolation={sections.isolation} />
      <SameStandardSection items={sections.honesty} />
    </div>
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
  /**
   * Optional headline {@link LanternStory} rendered ABOVE the table. Omitted
   * (the default) renders the table alone, so reports with no single lead
   * finding — and the existing tests — are unaffected.
   */
  story?: LanternStory;
  /**
   * Human label for the target, shown in the header ("Lantern Report · <label>"
   * / "Target: <label>"). Defaults to the writing-tracker label so that report
   * renders unchanged; the demo's target switcher passes each report's label.
   */
  targetLabel?: string;
  /**
   * The build-time-generated {@link ReportSectionsAsset} (the "Behind the
   * lantern" timelines, the isolation diagram, and the honesty items). When
   * present, the three sections render BELOW the story and ABOVE the table.
   * Omitted (the default) leaves the layout unchanged, so existing tests and
   * any report without the asset are unaffected.
   */
  sections?: ReportSectionsAsset;
  /**
   * The id of the currently-shown target (matches a timeline id), so the
   * per-target timeline in {@link ReportSections} renders the matching one.
   */
  targetId?: string;
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
  story,
  targetLabel = "writing-tracker (abandoned Lovable app)",
  sections,
  targetId,
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

  const sampleBadge = sampleData ? (
    <span
      className="lantern-sample-badge"
      data-testid={TEST_IDS.sampleBadge}
      title="Hand-authored sample data — replaced by real pipeline output (task 20)"
    >
      Sample data
    </span>
  ) : null;

  return (
    <section className="lantern" data-testid="lantern-report">
      {story ? (
        // With a story, the thesis IS the page headline (largest text), under a
        // small "Lantern Report · <target>" label. No separate summary line —
        // the story carries its own stat line.
        <header className="lantern-header lantern-header--story">
          <p
            className="lantern-header__label"
            data-testid={TEST_IDS.subheader}
          >
            <span className="lantern-header__flame" aria-hidden="true">
              🏮
            </span>
            Lantern Report · {targetLabel}
            {sampleBadge}
          </p>
          <h1
            className="lantern-header__headline"
            data-testid={TEST_IDS.storyThesis}
          >
            {story.thesis}
          </h1>
          {story.subhead ? (
            <p
              className="lantern-header__subhead"
              data-testid={TEST_IDS.storySubhead}
            >
              {story.subhead}
            </p>
          ) : null}
        </header>
      ) : (
        <header className="lantern-header">
          <h1 className="lantern-header__title">
            <span className="lantern-header__flame" aria-hidden="true">
              🏮
            </span>
            Lantern Report
            {sampleBadge}
          </h1>
          <p
            className="lantern-header__subheader"
            data-testid={TEST_IDS.subheader}
          >
            Target: {targetLabel}
          </p>
        </header>
      )}
      {story ? (
        <StorySection
          story={story}
          lieCount={countLies(report.comparisons)}
          checkedCount={report.comparisons.length}
        />
      ) : null}
      {sections ? (
        <ReportSections sections={sections} targetId={targetId} />
      ) : null}
      <PropertyTable comparisons={report.comparisons} />
    </section>
  );
}
