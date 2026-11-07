// Feature: spec-lantern, Property 2: a 12-hour AM/PM closing time parses to the right minutes since midnight

// Correctness_Property for the MoodPlays Claim claim-12h-to-minutes. It targets
// the 12-hour time parsing in
//   sandbox/moodplays/src/utils/openingHoursParser.ts
// whose comment on L25 reads "// Handle 12-hour format (e.g., \"10:00 PM\")".
//
// 1:1 mapping: this is the one and only property test file for
// claim-12h-to-minutes. parseTimeToMinutes is internal, so the claim is
// verified THROUGH the exported getClosingSoonInfo with a 12-hour range
// ("10:00 AM - H:MM PM"). The property computes the intended minutes since
// midnight for the close time using the documented rule (PM adds 12 except at
// 12 PM; 12 AM is midnight) and asserts getClosingSoonInfo reports the matching
// closingTime and minutesUntilClose. "now" is pinned so the close is in the
// (0, 12h] window.
//
// kind: function. getClosingSoonInfo reads `new Date()`, so the clock is pinned
// with Vitest fake timers and TZ=UTC. Terminates PASS or FAIL; >=100 runs.

import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";

import { getClosingSoonInfo } from "@/utils/openingHoursParser";

process.env.TZ = "UTC";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Intended minutes-since-midnight for a 12h close time per the documented rule. */
function expectedMinutes(hour12: number, minute: number, period: "AM" | "PM"): number {
  let h = hour12;
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + minute;
}

afterEach(() => {
  vi.useRealTimers();
});

test("a 12-hour AM/PM closing time parses to the right minutes since midnight", () => {
  fc.assert(
    fc.property(
      fc.record({
        // Afternoon/evening PM close times (1 PM .. 11 PM) keep the close in the
        // same calendar day as a daytime "now", so no midnight wrap is involved
        // here (that is Property 5's concern). This isolates the 12h parse.
        closeHour12: fc.integer({ min: 1, max: 11 }),
        closeMinute: fc.integer({ min: 0, max: 59 }),
        minutesBeforeClose: fc.integer({ min: 1, max: 600 }),
      }),
      ({ closeHour12, closeMinute, minutesBeforeClose }) => {
        const period = "PM" as const;
        const closeMinutes = expectedMinutes(closeHour12, closeMinute, period);
        const nowMinutes = closeMinutes - minutesBeforeClose; // > 0
        const nowHour = Math.floor(nowMinutes / 60);
        const nowMin = nowMinutes % 60;

        const closeStr = `${closeHour12}:${pad2(closeMinute)} ${period}`;
        const openingHours = `10:00 AM - ${closeStr}`;

        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2020, 0, 15, nowHour, nowMin, 0)));
        try {
          const info = getClosingSoonInfo(openingHours);

          expect(
            info.closingTime,
            `expected closingTime ${closeStr}, actual ${String(info.closingTime)}`,
          ).toBe(closeStr);

          // minutesUntilClose proves the 12h string parsed to closeMinutes.
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
