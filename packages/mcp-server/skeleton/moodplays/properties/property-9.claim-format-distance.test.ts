// Feature: spec-lantern, Property 9: formatDistance renders meters under 1 km and one-decimal km at or above 1 km

// Correctness_Property for the MoodPlays Claim claim-format-distance. It targets
// the exported formatDistance in
//   sandbox/moodplays/src/utils/distanceCalculator.ts
// whose doc comment on L34 reads "Format distance for display" and on L36 reads
//   "@returns Formatted string (e.g., \"1.2 km\" or \"500 m\")".
//
// 1:1 mapping: this is the one and only property test file for
// claim-format-distance. formatDistance is exported and pure, so the property
// calls it directly and asserts the documented rendering derived from the
// claim: distances under 1 km as whole rounded meters ("N m") and 1 km or more
// as one-decimal kilometers ("X.X km").
//
// kind: function. No clock is read; TZ pinned only for consistency.
// Terminates PASS or FAIL; >=100 runs.

import { expect, test } from "vitest";
import fc from "fast-check";

import { formatDistance } from "@/utils/distanceCalculator";

process.env.TZ = "UTC";

/** The documented rendering derived from the claim's promise. */
function intendedLabel(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

test("formatDistance renders meters under 1 km and one-decimal km at or above 1 km", () => {
  fc.assert(
    fc.property(
      // Non-negative distances spanning both regimes (sub-1 km and multi-km).
      fc.double({ min: 0, max: 20000, noNaN: true }),
      (km) => {
        const actual = formatDistance(km);
        const expected = intendedLabel(km);
        expect(
          actual,
          `expected "${expected}" for ${km} km, actual "${actual}"`,
        ).toBe(expected);

        // Unit suffix follows the 1 km boundary (icon/label contract).
        if (km < 1) {
          expect(actual.endsWith(" m"), `expected meters for ${km}`).toBe(true);
        } else {
          expect(actual.endsWith(" km"), `expected km for ${km}`).toBe(true);
        }
      },
    ),
    { numRuns: 100 },
  );
});
