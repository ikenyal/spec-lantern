// Feature: spec-lantern, Property 3: the first Most Active Stages row has the highest activity score and the table shows at most five rows
//
// Correctness_Property for the writing-tracker "Most Active Stages" Claim
// (claim-active-stages-top5). It targets the stage-ranking logic in
//   sandbox/writing-tracker/src/components/statistics/MostActiveItemsList.tsx
// whose comment on L24 reads "// Top 5 most active stages" (the stages are
// scored by `(progress || 0) + (is_completed ? 100 : 0)`, sorted descending,
// and sliced to five).
//
// 1:1 mapping: this is the one and only property test file for
// claim-active-stages-top5. It asserts the INTENDED behavior the comment
// promises — the first displayed stage row is the highest-scoring stage AND the
// table never shows more than five rows — by rendering the REAL
// MostActiveItemsList component (no hand-copied ranking reproduction), injecting
// `stages` and `tasks` via props, and reading the "Most Active Stages" table
// off the rendered DOM.
//
// kind: component_rendered. The component is props-driven (stages: Stage[],
// tasks: Task[]), so the MCP_Server renders it in jsdom with injected data and
// evaluates the property against the rendered DOM (R4.2, R4.3).
//
// The generator produces stages with DISTINCT activity scores (via distinct
// progress values and is_completed = false) so the top stage has an unambiguous
// title and progress cell. This file keeps the `.test.ts` extension and uses
// React.createElement; it terminates with exactly one of PASS or FAIL and runs
// a minimum of 100 fast-check iterations.

import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import fc from "fast-check";

import MostActiveItemsList from "@/components/statistics/MostActiveItemsList";

process.env.TZ = "UTC";

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("the first Most Active Stages row has the highest activity score and the table shows at most five rows", async () => {
  await fc.assert(
    fc.asyncProperty(
      // A non-empty set of stages with DISTINCT progress values (0..100) and
      // is_completed = false, so each activity score == progress and the top
      // stage is unambiguous. Distinct progress guarantees a unique maximum.
      fc
        .uniqueArray(fc.integer({ min: 0, max: 100 }), {
          minLength: 1,
          maxLength: 8,
        })
        .chain((progresses) =>
          fc.record({
            progresses: fc.constant(progresses),
            titles: fc.array(
              fc.string({ minLength: 1, maxLength: 12 }),
              { minLength: progresses.length, maxLength: progresses.length },
            ),
          }),
        ),
      async ({ progresses, titles }) => {
        const iso = new Date(Date.UTC(2020, 0, 1, 12, 0, 0)).toISOString();
        // Ensure titles are unique AND whitespace-free so the first-row title
        // match is unambiguous (a raw generated title could be whitespace,
        // which trims away; trimming it here keeps expected and rendered equal).
        const stages: Stage[] = progresses.map((p, i) => ({
          id: `stage-${i}`,
          book_id: "book-0",
          title: `${(titles[i] || "Stage").trim() || "Stage"}#${i}`,
          progress: p,
          is_completed: false,
          order_position: i,
          created_at: iso,
          updated_at: iso,
        }));

        const maxIdx = progresses.reduce(
          (best, p, i) => (p > progresses[best] ? i : best),
          0,
        );
        const expectedTitle = stages[maxIdx].title;

        try {
          render(createElement(MostActiveItemsList, { stages, tasks: [] as Task[] }));

          // HARNESS LOOKUP (revised): locate the "Most Active Stages" table
          // ROBUSTLY by its unique "Stage" column header rather than by walking
          // an assumed card DOM shape. Ascend from that columnheader to the
          // enclosing <table>, then read the first BODY data row. This is purely
          // how the test FINDS the row; it does not change what the property
          // asserts about the claim.
          const stageHeader = screen.getByRole("columnheader", { name: "Stage" });
          const table = stageHeader.closest("table");
          if (!table) throw new Error("stages table not found");
          const body = table.querySelector("tbody");
          if (!body) throw new Error("stages table body not found");
          const dataRows = within(body as HTMLElement).getAllByRole("row");
          if (dataRows.length === 0) throw new Error("no stage rows rendered");

          const firstTitle = within(dataRows[0])
            .getAllByRole("cell")[0]
            ?.textContent?.trim();

          // Intended behavior: first row is the highest-scoring stage AND at
          // most five rows are shown. Both are plain expects so an ordering or
          // cap violation surfaces as VERDICT FAIL, never a thrown Error. The
          // expected title is trimmed too so both sides compare consistently.
          expect(
            firstTitle,
            `expected first stage row title: ${expectedTitle.trim()}, actual: ${firstTitle}`,
          ).toBe(expectedTitle.trim());
          expect(
            dataRows.length,
            `expected at most 5 stage rows, actual: ${dataRows.length}`,
          ).toBeLessThanOrEqual(5);
        } finally {
          cleanup();
        }
      },
    ),
    { numRuns: 100 },
  );
});
