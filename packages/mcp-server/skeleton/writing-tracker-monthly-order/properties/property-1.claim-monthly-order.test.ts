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
// This file exercises the REAL component (no hand-copied getPeriods()
// reproduction). It imports PeriodProgressSummary through the `@` → ./src path
// alias that the working-copy vitest config supplies (task 4.3), renders it in
// jsdom with @testing-library/react, switches to the Monthly tab, and reads the
// first Month-column label straight off the rendered DOM. getPeriods() reads
// `new Date()` directly (the host clock), so the property pins the clock with
// Vitest fake timers and pins TZ to UTC to make month boundaries deterministic.
//
// Note on JSX: this file keeps the `.test.ts` extension (part of the 1:1
// Claim->property->prediction filename stem) and therefore builds the element
// with React.createElement rather than JSX syntax, which would be ambiguous in
// a `.ts` file.
//
// This file terminates with exactly one of PASS or FAIL. fast-check runs a
// minimum of 100 iterations (pinned here explicitly as `{ numRuns: 100 }`). The
// generator supplies the Fixed_Current_Time the real runner will inject via the
// ExecutionContext; here it is a smart generator over plausible "now" instants
// so the property is deterministic per run and never reads the host wall clock.

import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import fc from "fast-check";

// Import the REAL component under test via the `@` -> ./src alias the
// working-copy vitest config provides. We do NOT import from sandbox/ directly
// and we do NOT reproduce getPeriods().
import PeriodProgressSummary from "@/components/statistics/PeriodProgressSummary";

// Pin the timezone so month boundaries (new Date(year, month, 1)) are
// deterministic regardless of the host/container's local zone. The runner also
// sets TZ from the ExecutionContext; setting it here keeps the property
// self-consistent when run directly.
process.env.TZ = "UTC";

// The month-name table the component uses to build its row labels.
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Structural shape of the component's `books` prop. We declare it locally
// (rather than importing `Book` from the service) so the property does not
// transitively pull in `@/integrations/supabase/client` just to borrow a type;
// the component itself still imports and resolves `Book` inside the container.
interface Book {
  id: string;
  title: string;
  progress: number;
  is_completed: boolean;
  created_at: string;
  updated_at: string;
  order_position: number;
}

/** The expected first-row label under the intended (comment-promised) behavior. */
function currentMonthLabel(now: Date): string {
  return `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
}

afterEach(() => {
  // Defensive: tear down any rendered tree and restore the real clock so a
  // failing/throwing iteration cannot leak DOM or fake timers into the next.
  cleanup();
  vi.useRealTimers();
});

test("the first monthly row is the current month (most recent month first)", async () => {
  await fc.assert(
    fc.asyncProperty(
      // Smart generator constrained to the real input space: a plausible
      // "current time" the Controllable_Clock would pin (any valid month in a
      // realistic year range exercises the ordering logic; day 1..28 avoids
      // month-overflow surprises and is irrelevant to month ordering), plus a
      // possibly-empty books array passed through props.
      fc.record({
        year: fc.integer({ min: 2000, max: 2100 }),
        month: fc.integer({ min: 0, max: 11 }),
        day: fc.integer({ min: 1, max: 28 }),
      }),
      fc.array(
        fc.record({
          id: fc.uuid(),
          title: fc.string(),
          progress: fc.integer({ min: 0, max: 100 }),
          is_completed: fc.boolean(),
          created_at: fc
            .date({ min: new Date("2000-01-01"), max: new Date("2100-12-31") })
            .map((d) => d.toISOString()),
          updated_at: fc
            .date({ min: new Date("2000-01-01"), max: new Date("2100-12-31") })
            .map((d) => d.toISOString()),
          order_position: fc.integer({ min: 0, max: 1000 }),
        }),
        { maxLength: 5 },
      ),
      async ({ year, month, day }, books: Book[]) => {
        const now = new Date(year, month, day, 12, 0, 0);

        // Pin the host clock the component reads via `new Date()`.
        vi.useFakeTimers();
        vi.setSystemTime(now);

        try {
          render(createElement(PeriodProgressSummary, { books }));

          // Switch to the Monthly tab. Radix Tabs activates the monthly
          // TabsContent via onValueChange when its trigger is clicked.
          fireEvent.click(screen.getByRole("tab", { name: "Monthly" }));

          // Wait for the monthly tabpanel to become active, then read the first
          // data row's Month-column label. The active tabpanel's first body row
          // is the first data row; its first cell holds the month label.
          const label = await waitFor(() => {
            const panel = screen.getByRole("tabpanel");
            const rows = within(panel).getAllByRole("row");
            // rows[0] is the header row (Month / Books Updated / ...); the first
            // DATA row is rows[1], whose first cell holds the month label.
            const firstDataRow = rows[1];
            const firstCell = within(firstDataRow).getAllByRole("cell")[0];
            const text = firstCell?.textContent?.trim();
            if (!text) throw new Error("month label not rendered yet");
            return text;
          });

          // Intended behavior (the comment's promise): the FIRST row is the most
          // recent month, i.e. the current month. On the real buggy code the
          // first row is the OLDEST month, so this assertion FAILS — which is the
          // whole point of the walking skeleton (execute vs. trust-the-comment).
          expect(label).toBe(currentMonthLabel(now));
        } finally {
          // Clean up this iteration's DOM + timers before the next one.
          cleanup();
          vi.useRealTimers();
        }
      },
    ),
    { numRuns: 100 },
  );
});
