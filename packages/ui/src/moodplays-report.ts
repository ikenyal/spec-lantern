/**
 * The REAL MoodPlays Lantern_Report (second Target_Repo, Stage E).
 *
 * NOT sample data. Every value is traceable to a persisted spec-lantern
 * artifact under packages/mcp-server/skeleton/moodplays/ — never invented
 * (see .kiro/steering/report-data-fidelity.md):
 *
 *   - `display.claimText` / `sourceLocation`: verbatim comments from
 *     src/utils/openingHoursParser.ts (+ distanceCalculator.ts / moodMapper.ts),
 *     reverse-engineered into claims.json.
 *   - `predicted`: the LOCKED prediction verdict (locks/*.lock.json — all PASS).
 *   - `actual` (+ counterexample + executionContext): the verbatim
 *     execute_properties output in results/stage-c/*.json.
 *   - `transition`: the apply_fixes_and_reexecute output in
 *     results/stage-d/apply-fixes-reexecute-all.json (property-1 and property-6
 *     FIXED; the other eight STILL_PASSING — no regression).
 *   - `observedDeviations`: observed-deviations.json ({ deviations: [] } — the
 *     deviations were found by EXECUTION, recorded as Confirmed_Bugs on the
 *     comparisons, not pre-authored).
 *
 * Target: gargi04sahu/MoodPlays @ 4b4152f (MIT © 2026 Gargi Sahu). Selected by
 * fixed criteria BEFORE any claim was verified (docs/target-selection.md).
 */
import type { LanternReport } from "@spec-lantern/types";
import type { LanternStory } from "./report-asset.js";

/** Pre-fix FAIL counterexample for property-1, verbatim from stage-c. */
const P1_COUNTEREXAMPLE = {
  propertyId: "property-1.claim-24h-to-minutes",
  input: '[{"openHour":0,"closeHour":13,"closeMinute":24,"minutesBeforeClose":1}]',
  observedOutput:
    "expected '13:24', actual closingTime 13:24, actual null: expected null\n---\nError: Property failed after 48 tests",
  executionContext: {
    randomSeed: 3358481083,
    timezone: "UTC",
    fixedCurrentTime: "2025-01-01T00:00:00.000Z",
  },
} as const;

/** Pre-fix FAIL counterexample for property-6, verbatim from stage-c. */
const P6_COUNTEREXAMPLE = {
  propertyId: "property-6.claim-stale-closed",
  input: '[{"closeHour":0,"closeMinute":24,"minutesUntilClose":721}]',
  observedOutput:
    "expected '00:24', actual closingTime 00:24, actual null: expected null\n---\nError: Property failed after 7 tests",
  executionContext: {
    randomSeed: 1039160878,
    timezone: "UTC",
    fixedCurrentTime: "2025-01-01T00:00:00.000Z",
  },
} as const;

export const MOODPLAYS_REPORT: LanternReport = {
  comparisons: [
    {
      propertyId: "property-1.claim-24h-to-minutes",
      predicted: "PASS",
      actual: {
        propertyId: "property-1.claim-24h-to-minutes",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample: P1_COUNTEREXAMPLE,
      },
      transition: {
        propertyId: "property-1.claim-24h-to-minutes",
        preFixResult: "FAIL",
        postFixResult: "PASS",
        classification: "FIXED",
      },
      status: "PREDICTION_MISMATCH",
      confirmedBug: true,
      display: {
        title: "A 24-hour closing time parses to minutes since midnight",
        claimText: "// Handle 24-hour format (e.g., \"22:00\")",
        sourceLocation: "openingHoursParser.ts:17",
      },
    },
    {
      propertyId: "property-2.claim-12h-to-minutes",
      predicted: "PASS",
      actual: { propertyId: "property-2.claim-12h-to-minutes", outcome: "VERDICT", verdict: "PASS" },
      transition: {
        propertyId: "property-2.claim-12h-to-minutes",
        preFixResult: "PASS",
        postFixResult: "PASS",
        classification: "STILL_PASSING",
      },
      status: "MATCH",
      confirmedBug: false,
      display: {
        title: "A 12-hour AM/PM closing time parses to minutes since midnight",
        claimText: "// Handle 12-hour format (e.g., \"10:00 PM\")",
        sourceLocation: "openingHoursParser.ts:25",
      },
    },
    {
      propertyId: "property-3.claim-extract-closing-formats",
      predicted: "PASS",
      actual: { propertyId: "property-3.claim-extract-closing-formats", outcome: "VERDICT", verdict: "PASS" },
      transition: {
        propertyId: "property-3.claim-extract-closing-formats",
        preFixResult: "PASS",
        postFixResult: "PASS",
        classification: "STILL_PASSING",
      },
      status: "MATCH",
      confirmedBug: false,
      display: {
        title: "Closing time extracted from both documented range formats",
        claimText: '// Format: "HH:MM AM - HH:MM PM" or "HH:MM - HH:MM"',
        sourceLocation: "openingHoursParser.ts:57",
      },
    },
    {
      propertyId: "property-4.claim-24h-never-closing",
      predicted: "PASS",
      actual: { propertyId: "property-4.claim-24h-never-closing", outcome: "VERDICT", verdict: "PASS" },
      transition: {
        propertyId: "property-4.claim-24h-never-closing",
        preFixResult: "PASS",
        postFixResult: "PASS",
        classification: "STILL_PASSING",
      },
      status: "MATCH",
      confirmedBug: false,
      display: {
        title: "A place open 24 hours is never reported as closing soon",
        claimText: "// Open 24 hours, never closing",
        sourceLocation: "openingHoursParser.ts:53",
      },
    },
    {
      propertyId: "property-5.claim-after-midnight",
      predicted: "PASS",
      actual: { propertyId: "property-5.claim-after-midnight", outcome: "VERDICT", verdict: "PASS" },
      transition: {
        propertyId: "property-5.claim-after-midnight",
        preFixResult: "PASS",
        postFixResult: "PASS",
        classification: "STILL_PASSING",
      },
      status: "MATCH",
      confirmedBug: false,
      display: {
        title: "A closing time after midnight yields positive minutes-until-close",
        claimText: "// Handle cases where closing time is after midnight (e.g., 1:00 AM)",
        sourceLocation: "openingHoursParser.ts:93",
      },
    },
    {
      propertyId: "property-6.claim-stale-closed",
      predicted: "PASS",
      actual: {
        propertyId: "property-6.claim-stale-closed",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample: P6_COUNTEREXAMPLE,
      },
      transition: {
        propertyId: "property-6.claim-stale-closed",
        preFixResult: "FAIL",
        postFixResult: "PASS",
        classification: "FIXED",
      },
      status: "PREDICTION_MISMATCH",
      confirmedBug: true,
      display: {
        title: "More than 12h until close is treated as already closed",
        claimText:
          "// If more than 12 hours until close, it's probably already closed from yesterday",
        sourceLocation: "openingHoursParser.ts:100",
        // Not a lie itself: this comment holds. It only failed because the
        // 24h-detection defect (property-1's root cause) dropped the close time
        // before this >12h branch ran. Labeled a symptom, not a lie.
        symptomOf: "24h-detection bug",
      },
    },
    {
      propertyId: "property-7.claim-format-until-close",
      predicted: "PASS",
      actual: { propertyId: "property-7.claim-format-until-close", outcome: "VERDICT", verdict: "PASS" },
      transition: {
        propertyId: "property-7.claim-format-until-close",
        preFixResult: "PASS",
        postFixResult: "PASS",
        classification: "STILL_PASSING",
      },
      status: "MATCH",
      confirmedBug: false,
      display: {
        title: "formatTimeUntilClose renders the documented human-readable strings",
        claimText: "* Format minutes until close into a human-readable string",
        sourceLocation: "openingHoursParser.ts:113",
      },
    },
    {
      propertyId: "property-8.claim-haversine-distance",
      predicted: "PASS",
      actual: { propertyId: "property-8.claim-haversine-distance", outcome: "VERDICT", verdict: "PASS" },
      transition: {
        propertyId: "property-8.claim-haversine-distance",
        preFixResult: "PASS",
        postFixResult: "PASS",
        classification: "STILL_PASSING",
      },
      status: "MATCH",
      confirmedBug: false,
      display: {
        title: "calculateDistance returns the real great-circle distance in km",
        claimText: "* Calculate distance between two coordinates using the Haversine formula",
        sourceLocation: "distanceCalculator.ts:2",
      },
    },
    {
      propertyId: "property-9.claim-format-distance",
      predicted: "PASS",
      actual: { propertyId: "property-9.claim-format-distance", outcome: "VERDICT", verdict: "PASS" },
      transition: {
        propertyId: "property-9.claim-format-distance",
        preFixResult: "PASS",
        postFixResult: "PASS",
        classification: "STILL_PASSING",
      },
      status: "MATCH",
      confirmedBug: false,
      display: {
        title: "formatDistance renders meters under 1 km and one-decimal km otherwise",
        claimText: '* @returns Formatted string (e.g., "1.2 km" or "500 m")',
        sourceLocation: "distanceCalculator.ts:36",
      },
    },
    {
      propertyId: "property-10.claim-mood-categories-lookup",
      predicted: "PASS",
      actual: { propertyId: "property-10.claim-mood-categories-lookup", outcome: "VERDICT", verdict: "PASS" },
      transition: {
        propertyId: "property-10.claim-mood-categories-lookup",
        preFixResult: "PASS",
        postFixResult: "PASS",
        classification: "STILL_PASSING",
      },
      status: "MATCH",
      confirmedBug: false,
      display: {
        title: "A mood's categories include what its inline comment names",
        claimText: "// Restaurants, cafes, bars for dates",
        sourceLocation: "moodMapper.ts:29",
      },
    },
  ],
  observedDeviations: [],
  noConfirmedBug: false,
  noObservedDeviation: true,
  generatedAt: "2026-11-07T21:37:48.796Z",
} as const;

/**
 * The headline story for MoodPlays. ONE root-cause lie with two symptoms
 * (properties 1 and 6). Every value is verbatim from the persisted artifacts:
 *
 *   - comment: the 24h-detection comment at openingHoursParser.ts:51-53.
 *   - prediction: the locked PASS + lockedAt + short hash of property-1
 *     (locks/property-1.claim-24h-to-minutes.lock.json — the symptom whose claim
 *     is genuinely contradicted).
 *   - execution: the fixedCurrentTime / timezone + the two counterexamples
 *     from results/stage-c/*.json.
 *   - revive: results/stage-d/fix-task-1.diff + the FIXED transitions +
 *     reproducesSameFail from the replay files.
 */
export const MOODPLAYS_STORY: LanternStory = {
  propertyId: "property-1.claim-24h-to-minutes",
  thesis:
    "A comment said \"check for 24 hours\" — the code checked for the characters \"24\". spec-lantern made Kiro predict, then executed, then proved the gap.",
  // The lie count is the `{lies}` token, substituted by the UI with the number
  // computed from the report (countLies, which excludes symptomOf rows) so this
  // can never hard-write "1 lie" out of step with the data.
  stats: "10 claims checked · {lies} · Kiro fooled · fixed in 2 lines",
  comment: {
    claimText: "// Check for 24 hours … // Open 24 hours, never closing",
    sourceLocation: "openingHoursParser.ts:51-53",
  },
  prediction: {
    verdict: "PASS",
    lockedAt: "2026-11-07T20:54:49.867Z",
    shortHash: "bd00527b",
  },
  execution: {
    clock: "2025-01-01T00:00:00.000Z",
    timezone: "UTC",
    evidenceLines: [
      '"00:00-13:24" → close time 13:24 dropped; treated as open 24 hours (property-1, FAIL)',
      '"08:00-00:24" → close time 00:24 dropped before the >12h check runs (property-6, FAIL)',
    ],
    userImpact:
      "Places that close at times like 13:24 or 22:24 are treated as open 24 hours, so they never show \"closing soon\".",
  },
  revive: {
    diff: [
      "--- a/src/utils/openingHoursParser.ts",
      "+++ b/src/utils/openingHoursParser.ts",
      "@@ -48,8 +48,8 @@",
      " function extractClosingTime(openingHours: string): string | null {",
      "   if (!openingHours) return null;",
      "   ",
      "-  // Check for 24 hours",
      "-  if (openingHours.toLowerCase().includes('24')) {",
      "+  // Check for 24-hour operation (e.g. \"Open 24 hours\", \"24/7\"), not just any \"24\"",
      "+  if (/24\\s*(?:hours?|hrs?|\\/7)/i.test(openingHours)) {",
      "     return null; // Open 24 hours, never closing",
      "   }",
      "   ",
    ].join("\n"),
    preFixResult: "FAIL",
    postFixResult: "PASS",
    otherClaimsStatus:
      "Both symptoms (properties 1 and 6) went FAIL→PASS; the other 8 claims stayed PASS (no regression). claim-24h-to-minutes was genuinely contradicted; claim-stale-closed was not wrong on its own — it only failed because the 24h short-circuit fired first.",
    reproducesSameFail: true,
  },
  credit: "MoodPlays by Gargi Sahu (MIT).",
  selection: {
    note: "MoodPlays was picked by fixed criteria before any claim was verified — a pure openingHoursParser used by PlaceCard, chosen for testability, not for a suspected bug.",
    docPath: "docs/target-selection.md",
  },
} as const;

/** REAL pipeline output — not sample data. */
export const MOODPLAYS_IS_SAMPLE_DATA = false;
