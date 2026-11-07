// Feature: spec-lantern, Property 5: a closing time after midnight yields a positive minutes-until-close

// Correctness_Property for the MoodPlays Claim claim-after-midnight. It targets
// the past-midnight handling in getClosingSoonInfo in
//   sandbox/moodplays/src/utils/openingHoursParser.ts
// whose comment on L93 reads
//   "// Handle cases where closing time is after midnight (e.g., 1:00 AM)"
// and whose comment on L96 reads "// Closing time might be tomorrow (past midnight)".
//
// 1:1 mapping: this is the one and only property test file for
// claim-after-midnight. The claim is verified THROUGH the exported
// getClosingSoonInfo: when the close time is after midnight relative to a
// late-evening "now" (so the raw close-minus-now is negative), the result's
// minutesUntilClose must be the correct POSITIVE wrap into the next day
// (closeMinutes - nowMinutes + 24h), within the code's 12h window.
//
// kind: function. getClosingSoonInfo reads `new Date()`, so the clock is pinned
// with Vitest fake timers and TZ=UTC. Terminates PASS or FAIL; >=100 runs.

import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";

import { getClosingSoonInfo } from "@/utils/openingHoursParser";

process.env.TZ = "UTC";

const pad2 = (n: number): string => String(n).padStart(2, "0");

afterEach(() => {
  vi.useRealTimers();
});

test("a closing time after midnight yields a positive minutes-until-close", () => {
  fc.assert(
    fc.property(
      fc.record({
        // Close time just after midnight: 00:00 .. 02:59 (closeMinutes small).
        closeHour: fc.integer({ min: 0, max: 2 }),
        closeMinute: fc.integer({ min: 0, max: 59 }),
        // minutes until that close, in (0, 12h], so now is late the prior
        // evening and the wrap keeps us inside the code's 12h window.
        minutesUntilClose: fc.integer({ min: 1, max: 720 }),
      }),
      ({ closeHour, closeMinute, minutesUntilClose }) => {
        const closeMinutes = closeHour * 60 + closeMinute;
        // now = close - untilClose, wrapped into [0, 1440): a late-evening time.
        const nowMinutes = (closeMinutes - minutesUntilClose + 1440) % 1440;
        const nowHour = Math.floor(nowMinutes / 60);
        const nowMin = nowMinutes % 60;

        // Build a 24h range "18:00-HH:MM" whose close is the after-midnight time.
        const closeStr = `${pad2(closeHour)}:${pad2(closeMinute)}`;
        const openingHours = `18:00-${closeStr}`;

        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2020, 0, 15, nowHour, nowMin, 0)));
        try {
          const info = getClosingSoonInfo(openingHours);

          expect(
            info.closingTime,
            `expected closingTime ${closeStr}, actual ${String(info.closingTime)}`,
          ).toBe(closeStr);

          // The documented after-midnight handling: positive wrapped minutes.
          expect(
            info.minutesUntilClose,
            `expected minutesUntilClose ${minutesUntilClose} for close "${closeStr}" at now ${pad2(nowHour)}:${pad2(nowMin)}, actual ${String(info.minutesUntilClose)}`,
          ).toBe(minutesUntilClose);
        } finally {
          vi.useRealTimers();
        }
      },
    ),
    { numRuns: 100 },
  );
});
