// Feature: spec-lantern, Property 3: the closing time is extracted from both documented range formats

// Correctness_Property for the MoodPlays Claim claim-extract-closing-formats. It
// targets extractClosingTime in
//   sandbox/moodplays/src/utils/openingHoursParser.ts
// whose doc comment on L42-46 says it
//   "Handles formats like: \"10:00 AM - 10:00 PM\", \"10:00-22:00\", \"Open 24 hours\""
// and whose comment on L57 reads "// Format: \"HH:MM AM - HH:MM PM\" or \"HH:MM - HH:MM\"".
//
// 1:1 mapping: this is the one and only property test file for
// claim-extract-closing-formats. extractClosingTime is internal, so the claim is
// verified THROUGH the exported getClosingSoonInfo by asserting that the
// reported closingTime equals the close part of the range, for BOTH documented
// shapes: the 12-hour "H:MM AM - H:MM PM" shape and the 24-hour "HH:MM-HH:MM"
// shape. (The "Open 24 hours" shape is covered by Property 4.)
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

test("the closing time is extracted from both documented range formats", () => {
  fc.assert(
    fc.property(
      fc.record({
        format: fc.constantFrom("12h", "24h"),
        // 24h close hour (afternoon/evening) and minute.
        closeHour: fc.integer({ min: 13, max: 23 }),
        closeMinute: fc.integer({ min: 0, max: 59 }),
      }),
      ({ format, closeHour, closeMinute }) => {
        let openingHours: string;
        let expectedClosing: string;

        if (format === "24h") {
          const closeStr = `${pad2(closeHour)}:${pad2(closeMinute)}`;
          openingHours = `09:00-${closeStr}`;
          expectedClosing = closeStr;
        } else {
          // 12-hour shape: convert the afternoon/evening hour to H PM.
          const h12 = closeHour - 12 === 0 ? 12 : closeHour - 12;
          const closeStr = `${h12}:${pad2(closeMinute)} PM`;
          openingHours = `9:00 AM - ${closeStr}`;
          expectedClosing = closeStr;
        }

        // Pin "now" to 09:30 so there is always a positive, < 12h window to the
        // afternoon/evening close; this run only checks WHICH string is
        // extracted, not the exact minutes.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2020, 0, 15, 9, 30, 0)));
        try {
          const info = getClosingSoonInfo(openingHours);
          expect(
            info.closingTime,
            `expected closingTime ${expectedClosing} from "${openingHours}", actual ${String(info.closingTime)}`,
          ).toBe(expectedClosing);
        } finally {
          vi.useRealTimers();
        }
      },
    ),
    { numRuns: 100 },
  );
});
