// Feature: spec-lantern, Property 6: more than 12 hours until close is treated as already closed, not closing soon

// Correctness_Property for the MoodPlays Claim claim-stale-closed. It targets
// the "> 12 hours" guard in getClosingSoonInfo in
//   sandbox/moodplays/src/utils/openingHoursParser.ts
// whose comment on L100 reads
//   "// If more than 12 hours until close, it's probably already closed from yesterday".
//
// 1:1 mapping: this is the one and only property test file for
// claim-stale-closed. The claim is verified THROUGH the exported
// getClosingSoonInfo: when the computed minutes-until-close (after the
// past-midnight wrap) exceeds 12 hours, the result must report NOT closing soon
// and a null minutesUntilClose (the "already closed from yesterday" case),
// while still echoing the extracted closingTime.
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

test("more than 12 hours until close is treated as already closed, not closing soon", () => {
  fc.assert(
    fc.property(
      fc.record({
        closeHour: fc.integer({ min: 0, max: 23 }),
        closeMinute: fc.integer({ min: 0, max: 59 }),
        // Strictly more than 12h (721 .. 1439) of wrapped distance to close.
        minutesUntilClose: fc.integer({ min: 721, max: 1439 }),
      }),
      ({ closeHour, closeMinute, minutesUntilClose }) => {
        const closeMinutes = closeHour * 60 + closeMinute;
        const nowMinutes = (closeMinutes - minutesUntilClose + 1440) % 1440;
        const nowHour = Math.floor(nowMinutes / 60);
        const nowMin = nowMinutes % 60;

        const closeStr = `${pad2(closeHour)}:${pad2(closeMinute)}`;
        const openingHours = `08:00-${closeStr}`;

        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2020, 0, 15, nowHour, nowMin, 0)));
        try {
          const info = getClosingSoonInfo(openingHours);

          // The closing time is still extracted and echoed.
          expect(
            info.closingTime,
            `expected closingTime ${closeStr}, actual ${String(info.closingTime)}`,
          ).toBe(closeStr);

          // > 12h => treated as already closed: not closing soon, null minutes.
          expect(
            info.isClosingSoon,
            `expected isClosingSoon false (>12h) for close "${closeStr}" at now ${pad2(nowHour)}:${pad2(nowMin)}, actual ${String(info.isClosingSoon)}`,
          ).toBe(false);
          expect(
            info.minutesUntilClose,
            `expected minutesUntilClose null (>12h), actual ${String(info.minutesUntilClose)}`,
          ).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      },
    ),
    { numRuns: 100 },
  );
});
