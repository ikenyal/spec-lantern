/**
 * Sample Lantern_Report for the runnable demo (packages/ui/index.html).
 *
 * This is the real writing-tracker finding, not a toy: the "Monthly history"
 * view claims its first row is the current month, and Kiro *believed* that
 * (Predicted = PASS). Execution with the clock pinned to Jan 2000 disproved it
 * — the first row rendered was Aug 1999 — so the Actual is FAIL and the row is
 * a Confirmed_Bug (PREDICTION_MISMATCH). After the Revive loop the property was
 * Revived: pre-fix FAIL -> post-fix PASS.
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
      // The headline bug: "first row is the current month".
      propertyId: "monthly-history-first-row-is-current-month",
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
    {
      // A property Kiro believed and execution also confirmed.
      propertyId: "weekly-window-covers-seven-days",
      predicted: "PASS",
      actual: {
        propertyId: "weekly-window-covers-seven-days",
        outcome: "VERDICT",
        verdict: "PASS",
      },
      status: "MATCH",
      confirmedBug: false,
    },
  ],
  observedDeviations: [],
  noConfirmedBug: false,
  noObservedDeviation: true,
  generatedAt: "2000-01-15T00:00:05.000+09:00",
};
