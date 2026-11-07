// Feature: spec-lantern, Property 1: a 24-hour closing time in an "open-close" range parses to the right minutes since midnight

// Correctness_Property for the MoodPlays Claim claim-24h-to-minutes. It targets
// the 24-hour time parsing in
//   sandbox/moodplays/src/utils/openingHoursParser.ts
// whose comment on L12 reads
//   "Parse time string like \"10:00 PM\" or \"22:00\" to minutes since midnight"
// and whose comment on L17 reads "// Handle 24-hour format (e.g., \"22:00\")".
//
// 1:1 mapping: this is the one and only property test file for
// claim-24h-to-minutes. parseTimeToMinutes is not exported, so the claim is
// verified THROUGH the exported getClosingSoonInfo: a "HH:MM-HH:MM" range is fed
// in, and the property asserts that (a) the extracted closingTime is the
// 24-hour close string and (b) minutesUntilClose equals (closeMinutes -
// nowMinutes) — i.e. the 24-hour string was parsed to the correct minutes since
// midnight. We pick the current time so the answer is unambiguous and the
// 12-hour/stale-closed branches are not entered.
//
// kind: function. getClosingSoonInfo reads `new Date()` directly, so the clock
// is pinned with Vitest fake timers and TZ=UTC for determinism. The property
// terminates with exactly one of PASS or FAIL and runs >=100 fast-check
// iterations. The ordering/value assertion is a plain expect().toBe()/toEqual()
// so a real violation surfaces as VERDICT FAIL (AssertionError), never a thrown
// Error.

import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";

// Import the REAL function under test via the `@` -> ./src alias the
// working-copy vitest config provides. We do NOT import from sandbox/ directly
// and we do NOT reproduce the parser.
import { getClosingSoonInfo } from "@/utils/openingHoursParser";

process.env.TZ = "UTC";

const pad2 = (n: number): string => String(n).padStart(2, "0");

afterEach(() => {
  vi.useRealTimers();
});

test("a 24-hour closing time in an open-close range parses to the right minutes since midnight", () => {
  fc.assert(
    fc.property(
      // Open hour, close time (hour:minute) in 24h format, and a "now" chosen so
      // the close is strictly in the future today within the (0, 12h] window the
      // code treats as "still open today".
      fc.record({
        openHour: fc.integer({ min: 0, max: 9 }),
        closeHour: fc.integer({ min: 13, max: 23 }),
        closeMinute: fc.integer({ min: 0, max: 59 }),
        // minutes before close that it currently is (1..600 => within 10h, so
        // never > 12h and never <= 0): keeps us out of the 12h-stale branch.
        minutesBeforeClose: fc.integer({ min: 1, max: 600 }),
      }),
      ({ openHour, closeHour, closeMinute, minutesBeforeClose }) => {
        const closeMinutes = closeHour * 60 + closeMinute;
        const nowMinutes = closeMinutes - minutesBeforeClose; // > 0 by construction
        const nowHour = Math.floor(nowMinutes / 60);
        const nowMin = nowMinutes % 60;

        const closeStr = `${pad2(closeHour)}:${pad2(closeMinute)}`;
        const openStr = `${pad2(openHour)}:00`;
        const openingHours = `${openStr}-${closeStr}`;

        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2020, 0, 15, nowHour, nowMin, 0)));
        try {
          const info = getClosingSoonInfo(openingHours);

          // The 24-hour close string is extracted verbatim as closingTime.
          expect(
            info.closingTime,
            `expected closingTime ${closeStr}, actual ${String(info.closingTime)}`,
          ).toBe(closeStr);

          // minutesUntilClose proves the 24h string parsed to closeMinutes:
          // minutesUntilClose === closeMinutes - nowMinutes (both today, > 0).
          expect(
            info.minutesUntilClose,
            `expected minutesUntilClose ${minutesBeforeClose}, actual ${String(info.minutesUntilClose)}`,
          ).toBe(minutesBeforeClose);
        } finally {
          vi.useRealTimers();
        }
      },
    ),
    { numRuns: 100 },
  );
});
