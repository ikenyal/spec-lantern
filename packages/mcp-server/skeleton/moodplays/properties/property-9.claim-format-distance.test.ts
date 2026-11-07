// Feature: spec-lantern, Property 9: formatDistance renders the comment's examples and the values around the 1 km boundary

// Correctness_Property for the MoodPlays Claim claim-format-distance. It targets
// the exported formatDistance in
//   sandbox/moodplays/src/utils/distanceCalculator.ts
// whose doc comment on L34 reads "Format distance for display" and on L36 reads
//   "@returns Formatted string (e.g., \"1.2 km\" or \"500 m\")".
//
// 1:1 mapping: this is the one and only property test file for
// claim-format-distance.
//
// INDEPENDENT ORACLE (not the implementation restated). An earlier draft
// recomputed the same `km < 1 ? meters : toFixed(1)` branching as its oracle, so
// it mirrored the code and could not catch a wrong implementation. This version
// uses a FIXED table of (input -> expected string) written from the comment's
// stated intent and examples:
//   - the two examples the comment itself gives: 0.5 km -> "500 m",
//     1.2 km -> "1.2 km";
//   - concrete values straddling the 1 km boundary (0.999 / 1.0 / 1.001) to pin
//     which side renders meters vs kilometers;
//   - a few more hand-computed anchors across both regimes.
// Each expected string is written by hand from the claim, NOT derived by
// running the same conditional the code uses.
//
// kind: function. No clock is read; TZ pinned only for consistency.
// Terminates PASS or FAIL; >=100 runs (the table is asserted directly, and the
// fast-check block re-draws from the table to meet the >=100-iteration floor
// without reintroducing an implementation-shaped oracle).

import { expect, test } from "vitest";
import fc from "fast-check";

import { formatDistance } from "@/utils/distanceCalculator";

process.env.TZ = "UTC";

/** Hand-written (input km -> expected display string) anchors from the claim. */
const CASES: ReadonlyArray<{ km: number; expected: string }> = [
  // The two examples the comment states verbatim.
  { km: 0.5, expected: "500 m" },
  { km: 1.2, expected: "1.2 km" },
  // Sub-1 km meters, hand-computed (km * 1000, whole meters).
  { km: 0, expected: "0 m" },
  { km: 0.05, expected: "50 m" },
  { km: 0.25, expected: "250 m" },
  { km: 0.999, expected: "999 m" },
  // The 1 km boundary: exactly 1 km is kilometers, not meters.
  { km: 1, expected: "1.0 km" },
  { km: 1.001, expected: "1.0 km" },
  // Multi-km, one decimal, hand-computed.
  { km: 2.25, expected: "2.3 km" }, // 2.25 -> toFixed(1) rounds to 2.3
  { km: 12.04, expected: "12.0 km" },
  { km: 403, expected: "403.0 km" },
];

test("formatDistance renders the comment's examples and the values around the 1 km boundary", () => {
  // Direct table assertions.
  for (const { km, expected } of CASES) {
    const actual = formatDistance(km);
    expect(
      actual,
      `expected "${expected}" for ${km} km, actual "${actual}"`,
    ).toBe(expected);
  }

  // Meet the >=100-iteration floor by re-drawing from the SAME hand-written
  // table (fixed input/expected pairs) — never from the code's branching.
  fc.assert(
    fc.property(fc.constantFrom(...CASES), ({ km, expected }) => {
      expect(
        formatDistance(km),
        `expected "${expected}" for ${km} km`,
      ).toBe(expected);
    }),
    { numRuns: 100 },
  );
});
