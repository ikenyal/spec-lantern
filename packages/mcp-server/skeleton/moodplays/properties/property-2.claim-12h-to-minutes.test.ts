// Feature: spec-lantern, Property 2: a 12-hour AM/PM closing time parses to the right minutes since midnight

// Correctness_Property for the MoodPlays Claim claim-12h-to-minutes. It targets
// the 12-hour time parsing in
//   sandbox/moodplays/src/utils/openingHoursParser.ts
// whose comment on L25 reads "// Handle 12-hour format (e.g., \"10:00 PM\")".
//
// 1:1 mapping: this is the one and only property test file for
// claim-12h-to-minutes. parseTimeToMinutes is internal, so the claim is
// verified THROUGH the exported getClosingSoonInfo with a 12-hour range.
//
// INDEPENDENT ORACLE (not the code's AM/PM branch restated). An earlier draft
// computed the expected minutes with a helper that mirrored the implementation's
// own "PM -> +12 except 12, AM 12 -> 0" branches. This version instead picks the
// close time in UNAMBIGUOUS 24-hour terms (hour24, minute), formats it as the
// 12-hour "H:MM AM/PM" string that becomes the INPUT, and expects
// hour24 * 60 + minute — the true minutes-since-midnight, derived from the 24h
// value, never from the code's 12h conversion. Two FIXED cases pin the noon /
// midnight corners the comment's rule hinges on: "12:00 PM" -> 720 and
// "12:00 AM" -> 0.
//
// kind: function. getClosingSoonInfo reads `new Date()`, so the clock is pinned
// with Vitest fake timers and TZ=UTC. Terminates PASS or FAIL; >=100 runs.

import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";

import { getClosingSoonInfo } from "@/utils/openingHoursParser";

process.env.TZ = "UTC";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Render a 24-hour (hour, minute) as a 12-hour "H:MM AM/PM" input string. */
function to12hString(hour24: number, minute: number): string {
  const period = hour24 < 12 ? "AM" : "PM";
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h12}:${pad2(minute)} ${period}`;
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Drive one check: feed a 12h close string into getClosingSoonInfo with "now"
 * pinned so the (wrapped) gap to close is `gap` minutes (0 < gap <= 720), and
 * assert the echoed closingTime and that minutesUntilClose === gap — which can
 * only hold if the 12h string parsed to closeTrueMinutes.
 */
function checkClose(hour24: number, minute: number, gap: number): void {
  const closeTrueMinutes = hour24 * 60 + minute;
  const nowMinutes = (closeTrueMinutes - gap + 1440) % 1440;
  const closeStr = to12hString(hour24, minute);
  const openingHours = `10:00 AM - ${closeStr}`;

  vi.useFakeTimers();
  vi.setSystemTime(
    new Date(Date.UTC(2020, 0, 15, Math.floor(nowMinutes / 60), nowMinutes % 60, 0)),
  );
  try {
    const info = getClosingSoonInfo(openingHours);
    expect(
      info.closingTime,
      `expected closingTime ${closeStr}, actual ${String(info.closingTime)}`,
    ).toBe(closeStr);
    expect(
      info.minutesUntilClose,
      `expected minutesUntilClose ${gap} for "${closeStr}" (= ${closeTrueMinutes} min since midnight), actual ${String(info.minutesUntilClose)}`,
    ).toBe(gap);
  } finally {
    vi.useRealTimers();
  }
}

test("a 12-hour AM/PM closing time parses to the right minutes since midnight", () => {
  // Fixed corner cases the comment's rule hinges on.
  checkClose(12, 0, 60); // "12:00 PM" -> 720 min since midnight (noon)
  checkClose(0, 0, 60); //  "12:00 AM" -> 0 min since midnight (midnight)

  fc.assert(
    fc.property(
      fc.record({
        // Any wall-clock close time in 24h terms (unambiguous), formatted as a
        // 12h AM/PM string for input. hour24 0 and 12 are also covered above.
        hour24: fc.integer({ min: 0, max: 23 }),
        minute: fc.integer({ min: 0, max: 59 }),
        gap: fc.integer({ min: 1, max: 720 }),
      }),
      ({ hour24, minute, gap }) => {
        checkClose(hour24, minute, gap);
      },
    ),
    { numRuns: 100 },
  );
});
