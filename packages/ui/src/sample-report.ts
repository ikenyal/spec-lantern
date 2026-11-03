/**
 * Sample Lantern_Report for the runnable demo (packages/ui/index.html).
 *
 * TEMPORARY SAMPLE DATA. This file is a hand-authored stand-in until the real
 * pipeline output (task 20) replaces it; the UI shows a "Sample data" badge
 * while it is in use. Everything here is held to the same honesty bar as real
 * report data (see .kiro/steering/report-data-fidelity.md):
 *   - Every `claimText` is quoted VERBATIM from the real Target_Repo source,
 *     with the exact line number.
 *   - Every verdict/counterexample is one that was actually OBSERVED by
 *     executing the property — never invented.
 *
 * The single row below is the verified monthly-ordering bug. In
 * PeriodProgressSummary.tsx the "Monthly history" branch builds the six months
 * oldest-first, then does `periods.reverse()` under the comment on line 54:
 *
 *     // Reverse to have most recent month first      <- PeriodProgressSummary.tsx:54
 *     periods.reverse();
 *
 * Kiro *believed* that comment (Predicted = PASS). Executing the property with
 * the clock pinned disproved it — reversing a window that was generated with
 * `currentMonth - i` puts the OLDEST month first, so the first row rendered was
 * Aug 1999 when "now" was Jan 2000. Actual = FAIL, a Confirmed_Bug. After the
 * Revive loop the property was Revived: pre-fix FAIL -> post-fix PASS.
 *
 * A previously-included "weekly window" row was REMOVED: its comment was not
 * present in the source (line 38 is just `}`), so it violated the verbatim rule.
 * Only properties whose claim and result have been verified belong here.
 *
 * Kept as plain data so the demo stays props-driven and deterministic; the
 * clock, seed, and timezone are the ones the bug was reproduced under
 * (TZ=Asia/Tokyo, per the repo's time-dependent-bug convention).
 */
import type { LanternReport } from "@spec-lantern/types";

const reproContext = {
  randomSeed: 1,
  timezone: "Asia/Tokyo",
  fixedCurrentTime: "2000-01-15T00:00:00.000+09:00",
} as const;

export const WRITING_TRACKER_REPORT: LanternReport = {
  comparisons: [
    {
      // The verified bug: "Reverse to have most recent month first".
      propertyId: "monthly-history-first-row-is-current-month",
      display: {
        title: "Monthly history lists the current month first",
        // Verbatim from PeriodProgressSummary.tsx line 54.
        claimText: "Reverse to have most recent month first",
        sourceLocation: "PeriodProgressSummary.tsx:54",
      },
      predicted: "PASS",
      actual: {
        propertyId: "monthly-history-first-row-is-current-month",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample: {
          propertyId: "monthly-history-first-row-is-current-month",
          input: {
            now: "2000-01-15T00:00:00.000+09:00",
            timezone: "Asia/Tokyo",
            claim: "Reverse to have most recent month first",
          },
          observedOutput: {
            expectedFirstRow: "Jan 2000",
            actualFirstRow: "Aug 1999",
          },
          executionContext: reproContext,
        },
      },
      status: "PREDICTION_MISMATCH",
      confirmedBug: true,
      // Revived by the fix loop: FAIL -> PASS.
      transition: {
        propertyId: "monthly-history-first-row-is-current-month",
        preFixResult: "FAIL",
        postFixResult: "PASS",
        classification: "FIXED",
      },
    },
  ],
  observedDeviations: [],
  noConfirmedBug: false,
  noObservedDeviation: true,
  generatedAt: "2000-01-15T00:00:05.000+09:00",
};

/**
 * Marks {@link WRITING_TRACKER_REPORT} as hand-authored sample data so the UI
 * can surface a "Sample data" badge. Flipped off (removed) when task 20 wires
 * the real pipeline output into the demo.
 */
export const IS_SAMPLE_DATA = true;
