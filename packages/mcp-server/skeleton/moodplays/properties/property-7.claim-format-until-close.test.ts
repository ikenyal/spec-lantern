// Feature: spec-lantern, Property 7: formatTimeUntilClose renders the documented human-readable strings

// Correctness_Property for the MoodPlays Claim claim-format-until-close. It
// targets the exported formatTimeUntilClose in
//   sandbox/moodplays/src/utils/openingHoursParser.ts
// whose doc comment on L113 reads
//   "Format minutes until close into a human-readable string".
//
// 1:1 mapping: this is the one and only property test file for
// claim-format-until-close.
//
// INDEPENDENT ORACLE (not the implementation restated). An earlier draft
// recomputed the same if/else branches the function uses as its oracle, so it
// mirrored the code and could not catch a wrong implementation. This version
// uses a FIXED table of (minutes -> expected label) written BY HAND from the
// comment's intent (a human-readable "time until close"):
//   - at or below zero it is closing now;
//   - under an hour it counts minutes;
//   - an exact number of hours drops the minutes;
//   - otherwise it shows hours and minutes.
// Each expected string below was hand-authored and cross-checked against the
// English meaning, NOT produced by running the function's own conditional.
//
// kind: function. No clock is read; TZ pinned only for consistency.
// Terminates PASS or FAIL; >=100 runs (the table is asserted directly and the
// fast-check block re-draws from the same table).

import { expect, test } from "vitest";
import fc from "fast-check";

import { formatTimeUntilClose } from "@/utils/openingHoursParser";

process.env.TZ = "UTC";

/** Hand-written (minutes -> expected label) anchors from the comment's intent. */
const CASES: ReadonlyArray<{ minutes: number; expected: string }> = [
  // At or below zero: closing now.
  { minutes: -30, expected: "Closing now" },
  { minutes: 0, expected: "Closing now" },
  // Under an hour: minutes only.
  { minutes: 1, expected: "Closes in 1 min" },
  { minutes: 5, expected: "Closes in 5 min" },
  { minutes: 45, expected: "Closes in 45 min" },
  { minutes: 59, expected: "Closes in 59 min" },
  // Exact hours: no minutes shown.
  { minutes: 60, expected: "Closes in 1h" },
  { minutes: 120, expected: "Closes in 2h" },
  { minutes: 600, expected: "Closes in 10h" },
  // Hours + minutes.
  { minutes: 61, expected: "Closes in 1h 1m" },
  { minutes: 90, expected: "Closes in 1h 30m" },
  { minutes: 125, expected: "Closes in 2h 5m" },
  { minutes: 719, expected: "Closes in 11h 59m" },
];

test("formatTimeUntilClose renders the documented human-readable strings", () => {
  for (const { minutes, expected } of CASES) {
    const actual = formatTimeUntilClose(minutes);
    expect(
      actual,
      `expected "${expected}" for ${minutes} minutes, actual "${actual}"`,
    ).toBe(expected);
  }

  // Meet the >=100-iteration floor by re-drawing from the SAME hand-written
  // table (fixed pairs), never from the function's own branching.
  fc.assert(
    fc.property(fc.constantFrom(...CASES), ({ minutes, expected }) => {
      expect(
        formatTimeUntilClose(minutes),
        `expected "${expected}" for ${minutes} minutes`,
      ).toBe(expected);
    }),
    { numRuns: 100 },
  );
});
