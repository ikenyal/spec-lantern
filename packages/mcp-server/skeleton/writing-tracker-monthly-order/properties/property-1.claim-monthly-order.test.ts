// Feature: spec-lantern, Property 1: the first monthly row is the current month (most recent month first)
//
// Walking-skeleton Correctness_Property for the writing-tracker monthly-ordering
// Claim (claim-monthly-order). It targets the ordering logic in
//   sandbox/writing-tracker/src/components/statistics/PeriodProgressSummary.tsx
// whose comment on L54 reads "// Reverse to have most recent month first".
//
// 1:1 mapping: this is the one and only property test file for
// claim-monthly-order. It asserts the INTENDED behavior the comment promises —
// that the most recent month is shown first — so executing it exposes whether
// the code actually honors the comment. The comment-trusting, read-only
// prediction is PASS (see predictions/property-1.claim-monthly-order.predicted.json).
//
// This file terminates with exactly one of PASS or FAIL. fast-check runs a
// minimum of 100 iterations (enforced globally by vitest.setup.ts; pinned here
// explicitly as well). The generator supplies the Fixed_Current_Time the real
// runner will inject via the ExecutionContext; here it is a smart generator
// over plausible "now" instants so the property is deterministic per run and
// never reads the host wall clock.

import { test, expect } from "vitest";
import fc from "fast-check";

/**
 * Reproduces the monthly-period ordering from PeriodProgressSummary.getPeriods()
 * (the `period === 'monthly'` branch) EXACTLY, parameterized by the current
 * date so it is deterministic under a pinned clock rather than the host clock.
 *
 * The component builds 6 months as `currentMonth - i` for i = 0..5 (so the
 * array starts most-recent-first), then calls `periods.reverse()` under the
 * comment "Reverse to have most recent month first".
 */
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface MonthlyPeriod {
  label: string;
  start: Date;
  end: Date;
}

function getMonthlyPeriods(currentDate: Date): MonthlyPeriod[] {
  const periods: MonthlyPeriod[] = [];

  for (let i = 0; i < 6; i++) {
    const monthStart = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth() - i,
      1,
    );
    const monthEnd = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth() - i + 1,
      0,
    );

    const monthName = MONTH_NAMES[monthStart.getMonth()];

    periods.push({
      label: `${monthName} ${monthStart.getFullYear()}`,
      start: monthStart,
      end: monthEnd,
    });
  }

  // Reverse to have most recent month first
  periods.reverse();

  return periods;
}

/** The expected label of the current month under the intended behavior. */
function currentMonthLabel(currentDate: Date): string {
  const name = MONTH_NAMES[currentDate.getMonth()];
  return `${name} ${currentDate.getFullYear()}`;
}

test("the first monthly row is the current month (most recent month first)", () => {
  fc.assert(
    fc.property(
      // Smart generator constrained to the real input space: a plausible
      // "current time" the Controllable_Clock would pin. Any valid month in a
      // realistic year range exercises the ordering logic; the day-of-month is
      // irrelevant to month ordering but varied to avoid accidental alignment.
      fc.record({
        year: fc.integer({ min: 2000, max: 2100 }),
        month: fc.integer({ min: 0, max: 11 }),
        day: fc.integer({ min: 1, max: 28 }),
      }),
      ({ year, month, day }) => {
        const now = new Date(year, month, day, 12, 0, 0);
        const periods = getMonthlyPeriods(now);

        // Intended behavior (the comment's promise): the FIRST row is the most
        // recent month, i.e. the current month.
        expect(periods[0]?.label).toBe(currentMonthLabel(now));
      },
    ),
    { numRuns: 100 },
  );
});
