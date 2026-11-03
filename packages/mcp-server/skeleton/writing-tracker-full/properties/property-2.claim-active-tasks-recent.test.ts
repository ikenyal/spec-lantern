// Feature: spec-lantern, Property 2: the first Recently Active Tasks row is the most recently updated task
//
// Correctness_Property for the writing-tracker "Recently Active Tasks" Claim
// (claim-active-tasks-recent). It targets the task-ordering logic in
//   sandbox/writing-tracker/src/components/statistics/MostActiveItemsList.tsx
// whose comment on L31 reads "// Sort by updated_at date (most recent first)"
// and whose comment on L36 reads "// Top 5 most recently updated tasks".
//
// 1:1 mapping: this is the one and only property test file for
// claim-active-tasks-recent. It asserts the INTENDED behavior the comments
// promise — the first displayed task row is the task with the newest
// `updated_at` — by rendering the REAL MostActiveItemsList component (no
// hand-copied sort reproduction), injecting `stages` and `tasks` via props,
// reading the "Recently Active Tasks" table off the rendered DOM, and comparing
// the first data row's Last-Updated cell against the known most-recent task.
//
// kind: component_rendered. The component is props-driven (stages: Stage[],
// tasks: Task[]), so the MCP_Server renders it in jsdom with injected data and
// a Controllable_Clock and evaluates the property against the rendered DOM
// (R4.2, R4.3).
//
// The component formats each task's date as `${M}/${D}/${YYYY}` (local time),
// so the generator produces tasks on DISTINCT calendar days to keep the
// formatted date an unambiguous identity for the first row. TZ is pinned to UTC
// so the month/day/year the component derives from `new Date(updated_at)` are
// deterministic regardless of the host/container zone.
//
// This file keeps the `.test.ts` extension (part of the 1:1
// Claim->property->prediction filename stem) and therefore builds the element
// with React.createElement rather than JSX. It terminates with exactly one of
// PASS or FAIL; fast-check runs a minimum of 100 iterations.

import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import fc from "fast-check";

// Import the REAL component under test via the `@` -> ./src alias the
// working-copy vitest config provides. We do NOT import from sandbox/ directly
// and we do NOT reproduce the sort.
import MostActiveItemsList from "@/components/statistics/MostActiveItemsList";

// Pin the timezone so the component's date formatting (getMonth/getDate/
// getFullYear on `new Date(updated_at)`) is deterministic regardless of the
// host/container zone. The runner also sets TZ from the ExecutionContext.
process.env.TZ = "UTC";

// Structural shapes of the component's props. Declared locally (rather than
// importing the service types) so the property does not transitively pull in
// `@/integrations/supabase/client` just to borrow a type.
interface Stage {
  id: string;
  book_id: string;
  title: string;
  progress: number;
  is_completed: boolean;
  order_position: number;
  created_at: string;
  updated_at: string;
}
interface Task {
  id: string;
  stage_id: string;
  title: string;
  description: string | null;
  is_completed: boolean;
  order_position: number;
  task_references: unknown[] | null;
  created_at: string;
  updated_at: string;
}

/** The M/D/YYYY label the component renders for a task's updated_at (UTC-pinned). */
function formattedDateLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("the first Recently Active Tasks row is the most recently updated task", async () => {
  await fc.assert(
    fc.asyncProperty(
      // A non-empty set of tasks on DISTINCT calendar days so the most-recent
      // task has an unambiguous formatted date. We pick N distinct day offsets
      // from a fixed epoch; the newest task is the one with the largest offset.
      fc
        .uniqueArray(fc.integer({ min: 0, max: 4000 }), {
          minLength: 1,
          maxLength: 5,
        })
        .chain((dayOffsets) =>
          fc.record({
            dayOffsets: fc.constant(dayOffsets),
            titles: fc.array(
              fc.string({ minLength: 1, maxLength: 12 }),
              { minLength: dayOffsets.length, maxLength: dayOffsets.length },
            ),
          }),
        ),
      async ({ dayOffsets, titles }) => {
        // Build tasks: task i updated_at = epoch + dayOffsets[i] days (noon UTC
        // to stay clear of day boundaries).
        const epoch = Date.UTC(2020, 0, 1, 12, 0, 0);
        const dayMs = 24 * 60 * 60 * 1000;
        const tasks: Task[] = dayOffsets.map((off, i) => ({
          id: `task-${i}`,
          stage_id: "stage-0",
          title: titles[i] || `Task ${i}`,
          description: null,
          is_completed: false,
          order_position: i,
          task_references: [],
          created_at: new Date(epoch).toISOString(),
          updated_at: new Date(epoch + off * dayMs).toISOString(),
        }));

        // The expected most-recent task is the one with the max offset.
        const maxIdx = dayOffsets.reduce(
          (best, off, i) => (off > dayOffsets[best] ? i : best),
          0,
        );
        const expectedLabel = formattedDateLabel(tasks[maxIdx].updated_at);

        try {
          render(createElement(MostActiveItemsList, { stages: [] as Stage[], tasks }));

          // HARNESS LOOKUP (revised): locate the "Recently Active Tasks" table
          // ROBUSTLY by its unique "Last Updated" column header rather than by
          // walking an assumed card DOM shape. Ascend from that columnheader to
          // the enclosing <table>, then read the first BODY data row's
          // Last-Updated cell. This is purely how the test FINDS the row; it
          // does not change what the property asserts about the claim.
          const lastUpdatedHeader = screen.getByRole("columnheader", {
            name: "Last Updated",
          });
          const table = lastUpdatedHeader.closest("table");
          if (!table) throw new Error("tasks table not found");
          const body = table.querySelector("tbody");
          if (!body) throw new Error("tasks table body not found");
          const dataRows = within(body as HTMLElement).getAllByRole("row");
          if (dataRows.length === 0) throw new Error("no task rows rendered");
          const cells = within(dataRows[0]).getAllByRole("cell");
          // Cells are [title, lastUpdated, status]; trim consistently.
          const lastUpdated = cells[1]?.textContent?.trim();
          if (!lastUpdated) throw new Error("last-updated cell not rendered");

          // Intended behavior (the comments' promise): the FIRST row is the
          // most recently updated task. A plain expect().toBe() so a genuine
          // ordering violation surfaces as VERDICT FAIL (AssertionError), never
          // as a thrown Error. Both sides are already trimmed strings.
          expect(
            lastUpdated,
            `expected first task row last-updated: ${expectedLabel.trim()}, actual: ${lastUpdated}`,
          ).toBe(expectedLabel.trim());
        } finally {
          cleanup();
        }
      },
    ),
    { numRuns: 100 },
  );
});
