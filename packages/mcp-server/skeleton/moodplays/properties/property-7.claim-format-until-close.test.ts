// Feature: spec-lantern, Property 7: formatTimeUntilClose renders the documented human-readable strings

// Correctness_Property for the MoodPlays Claim claim-format-until-close. It
// targets the exported formatTimeUntilClose in
//   sandbox/moodplays/src/utils/openingHoursParser.ts
// whose doc comment on L113 reads
//   "Format minutes until close into a human-readable string".
//
// 1:1 mapping: this is the one and only property test file for
// claim-format-until-close. formatTimeUntilClose is exported and pure (no
// clock), so the property calls it directly and asserts the documented
// human-readable rendering for each regime:
//   - <= 0 minutes            -> "Closing now"
//   - 1..59 minutes           -> "Closes in N min"
//   - exact hours (>=60)      -> "Closes in Hh"
//   - hours + minutes (>=60)  -> "Closes in Hh Mm"
//
// kind: function. No clock is read; TZ is pinned only for consistency.
// Terminates PASS or FAIL; >=100 runs.

import { expect, test } from "vitest";
import fc from "fast-check";

import { formatTimeUntilClose } from "@/utils/openingHoursParser";

process.env.TZ = "UTC";

/** The documented human-readable rendering, derived from the comment's promise. */
function intendedLabel(minutes: number): string {
  if (minutes <= 0) return "Closing now";
  if (minutes < 60) return `Closes in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `Closes in ${hours}h` : `Closes in ${hours}h ${rem}m`;
}

test("formatTimeUntilClose renders the documented human-readable strings", () => {
  fc.assert(
    fc.property(
      // Cover all regimes: negative/zero, sub-hour, and multi-hour (exact and
      // with a remainder) via a wide integer range.
      fc.integer({ min: -120, max: 1440 }),
      (minutes) => {
        const actual = formatTimeUntilClose(minutes);
        const expected = intendedLabel(minutes);
        expect(
          actual,
          `expected "${expected}" for ${minutes} minutes, actual "${actual}"`,
        ).toBe(expected);
      },
    ),
    { numRuns: 100 },
  );
});
