// Feature: spec-lantern, Property 4: a place open 24 hours is never reported as closing soon

// Correctness_Property for the MoodPlays Claim claim-24h-never-closing. It
// targets the 24-hour short-circuit in extractClosingTime in
//   sandbox/moodplays/src/utils/openingHoursParser.ts
// whose comment on L51 reads "// Check for 24 hours" and whose comment on L53
// reads "return null; // Open 24 hours, never closing".
//
// 1:1 mapping: this is the one and only property test file for
// claim-24h-never-closing. The claim is verified THROUGH the exported
// getClosingSoonInfo: for an opening-hours string that states the place is open
// 24 hours, the result must report no closing time and never "closing soon",
// regardless of the current time.
//
// kind: function. getClosingSoonInfo reads `new Date()`, so the clock is pinned
// with Vitest fake timers and TZ=UTC across a range of "now" values. Terminates
// PASS or FAIL; >=100 runs.

import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";

import { getClosingSoonInfo } from "@/utils/openingHoursParser";

process.env.TZ = "UTC";

afterEach(() => {
  vi.useRealTimers();
});

test("a place open 24 hours is never reported as closing soon", () => {
  fc.assert(
    fc.property(
      fc.record({
        // Phrasings a 24-hour place uses; all contain "24".
        phrase: fc.constantFrom(
          "Open 24 hours",
          "open 24 hours",
          "24 hours",
          "24/7",
          "Open 24 Hours Daily",
        ),
        nowHour: fc.integer({ min: 0, max: 23 }),
        nowMinute: fc.integer({ min: 0, max: 59 }),
      }),
      ({ phrase, nowHour, nowMinute }) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2020, 0, 15, nowHour, nowMinute, 0)));
        try {
          const info = getClosingSoonInfo(phrase);

          // Intended behavior: open 24h => never closing, no closing time.
          expect(
            info.isClosingSoon,
            `expected isClosingSoon false for "${phrase}", actual ${String(info.isClosingSoon)}`,
          ).toBe(false);
          expect(
            info.closingTime,
            `expected no closingTime for "${phrase}", actual ${String(info.closingTime)}`,
          ).toBeNull();
          expect(
            info.minutesUntilClose,
            `expected minutesUntilClose null for "${phrase}", actual ${String(info.minutesUntilClose)}`,
          ).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      },
    ),
    { numRuns: 100 },
  );
});
