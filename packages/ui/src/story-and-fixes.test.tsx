// @vitest-environment jsdom
/**
 * Tests for the story section and the two report-fidelity fixes (task 20,
 * Stage E polish):
 *
 *   - Bug #1: extractExpectedActual parses the REAL string counterexample
 *     "expected first row: Jan 2000, actual first row: Aug 1999: …", so the
 *     evidence card shows "Expected Jan 2000 vs Actual Aug 1999" again.
 *   - Bug #2: summarize counts ONLY FIXED transitions as "revived"; a
 *     STILL_PASSING row renders a muted "Still passing after fix", not the
 *     tombstone → lantern revival visual.
 *   - Story: the headline narrative renders the thesis, the stat line, the four
 *     steps, the monthly mock with the current month highlighted, and the diff.
 *
 * All assertions run against the REAL pipeline output (src/real-report.ts), so
 * a fabricated or drifted value would fail the test (report-data-fidelity).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { PropertyComparison } from "@spec-lantern/types";
import {
  LanternReportView,
  TEST_IDS,
  extractExpectedActual,
  summarize,
} from "./index.js";
import { WRITING_TRACKER_REPORT, WRITING_TRACKER_STORY } from "./real-report.js";

afterEach(cleanup);

/** The real counterexample observedOutput string, verbatim from stage-c. */
const REAL_OUTPUT =
  "expected first row: Jan 2000, actual first row: Aug 1999: expected 'Aug 1999' to be 'Jan 2000' // Object.is equality\n---\nError: Property failed after 1 tests";

describe("bug #1: extractExpectedActual parses the real string counterexample", () => {
  it("extracts Expected Jan 2000 / Actual Aug 1999 from the string output", () => {
    const contrast = extractExpectedActual(REAL_OUTPUT);
    expect(contrast).toEqual({ expected: "Jan 2000", actual: "Aug 1999" });
  });

  it("still handles the structured object shapes", () => {
    expect(
      extractExpectedActual({ expectedFirstRow: "A", actualFirstRow: "B" }),
    ).toEqual({ expected: "A", actual: "B" });
    expect(extractExpectedActual({ expected: "X", actual: "Y" })).toEqual({
      expected: "X",
      actual: "Y",
    });
  });

  it("returns null for an unrecognised string", () => {
    expect(extractExpectedActual("something unrelated")).toBeNull();
  });

  it("renders the Expected/Actual contrast in the real report's evidence card", () => {
    render(<LanternReportView report={WRITING_TRACKER_REPORT} />);
    const card = screen.getByTestId(
      TEST_IDS.counterexample("property-1.claim-monthly-order"),
    );
    expect(card.textContent).toContain("Jan 2000");
    expect(card.textContent).toContain("Aug 1999");
  });
});

describe("bug #2: revived counts only FIXED; STILL_PASSING is muted", () => {
  it("summarize counts only FIXED transitions as revived", () => {
    // Real report: property-1 FIXED, properties 2 & 3 STILL_PASSING.
    const summary = summarize(WRITING_TRACKER_REPORT.comparisons);
    expect(summary.revived).toBe(1);
    expect(summary.exposed).toBe(1);
    expect(summary.checked).toBe(3);
  });

  it("header summary says '1 revived' for the real report", () => {
    render(<LanternReportView report={WRITING_TRACKER_REPORT} />);
    expect(screen.getByTestId(TEST_IDS.summary).textContent).toContain(
      "1 revived",
    );
  });

  it("a STILL_PASSING row shows the muted still-passing label, not the revival visual", () => {
    const comparison: PropertyComparison = {
      propertyId: "p-sp",
      predicted: "PASS",
      actual: { propertyId: "p-sp", outcome: "VERDICT", verdict: "PASS" },
      status: "MATCH",
      confirmedBug: false,
      transition: {
        propertyId: "p-sp",
        preFixResult: "PASS",
        postFixResult: "PASS",
        classification: "STILL_PASSING",
      },
    };
    render(
      <LanternReportView
        report={{
          comparisons: [comparison],
          observedDeviations: [],
          noConfirmedBug: true,
          noObservedDeviation: true,
          generatedAt: "2020-01-01T00:00:00.000Z",
        }}
      />,
    );
    const el = screen.getByTestId(TEST_IDS.transition("p-sp"));
    expect(el.className).toContain("lantern-still-passing");
    expect(el.textContent).toContain("Still passing after fix");
    // Not the "Revived" framing / tombstone.
    expect(el.textContent).not.toContain("Revived");
    expect(el.textContent).not.toContain("🪦");
  });

  it("a FIXED row still shows the revival visual", () => {
    const comparison: PropertyComparison = {
      propertyId: "p-fx",
      predicted: "PASS",
      actual: { propertyId: "p-fx", outcome: "VERDICT", verdict: "FAIL" },
      status: "PREDICTION_MISMATCH",
      confirmedBug: true,
      transition: {
        propertyId: "p-fx",
        preFixResult: "FAIL",
        postFixResult: "PASS",
        classification: "FIXED",
      },
    };
    render(
      <LanternReportView
        report={{
          comparisons: [comparison],
          observedDeviations: [],
          noConfirmedBug: false,
          noObservedDeviation: true,
          generatedAt: "2020-01-01T00:00:00.000Z",
        }}
      />,
    );
    const el = screen.getByTestId(TEST_IDS.transition("p-fx"));
    expect(el.className).toContain("lantern-revived");
    expect(el.textContent).toContain("Revived");
  });
});

describe("story section renders the lead finding from the real story", () => {
  function renderWithStory() {
    render(
      <LanternReportView
        report={WRITING_TRACKER_REPORT}
        story={WRITING_TRACKER_STORY}
      />,
    );
  }

  it("shows the thesis and the header stats verbatim", () => {
    renderWithStory();
    expect(screen.getByTestId(TEST_IDS.storyThesis).textContent).toBe(
      WRITING_TRACKER_STORY.thesis,
    );
    expect(screen.getByTestId(TEST_IDS.storyStats).textContent).toBe(
      "3 comments checked · 1 lie · Kiro fooled 1/3 · fixed in 2 lines",
    );
  });

  it("step 1 quotes the verbatim comment and its source location", () => {
    renderWithStory();
    const step = screen.getByTestId(TEST_IDS.storyStep(1));
    expect(step.textContent).toContain(
      "// Reverse to have most recent month first",
    );
    expect(step.textContent).toContain("PeriodProgressSummary.tsx:54");
  });

  it("step 2 shows predicted PASS, the lock time and the short hash", () => {
    renderWithStory();
    const step = screen.getByTestId(TEST_IDS.storyStep(2));
    expect(step.textContent).toContain("PASS");
    expect(step.textContent).toContain("2026-11-03T05:21:22.398Z");
    expect(step.textContent).toContain("0fcb9d68");
  });

  it("step 3 shows the clock, the Aug 1999 vs Jan 2000 result, and the impact", () => {
    renderWithStory();
    const step = screen.getByTestId(TEST_IDS.storyStep(3));
    expect(step.textContent).toContain("2000-01-01T00:00:00.000Z");
    expect(step.textContent).toContain("Aug 1999");
    expect(step.textContent).toContain("Jan 2000");
    expect(step.textContent).toContain("current month is at the bottom");
  });

  it("the monthly mock lists Aug 1999 … Jan 2000 and marks the current month", () => {
    renderWithStory();
    const table = screen.getByTestId(TEST_IDS.storyMonths);
    const rows = within(table).getAllByRole("row");
    // header + 6 month rows.
    expect(rows).toHaveLength(7);
    const bodyText = rows.slice(1).map((r) => r.textContent ?? "");
    expect(bodyText[0]).toContain("Aug 1999");
    expect(bodyText[5]).toContain("Jan 2000");
    // The current month (Jan 2000) is labeled, and renders LAST not first.
    expect(bodyText[5]).toContain("(current month)");
    expect(bodyText[0]).not.toContain("(current month)");
  });

  it("step 4 shows FAIL → PASS, the 2-line diff, and the replay flag", () => {
    renderWithStory();
    const step = screen.getByTestId(TEST_IDS.storyStep(4));
    expect(step.textContent).toContain("FAIL");
    expect(step.textContent).toContain("PASS");
    expect(step.textContent).toContain("reproducesSameFail: true");
    const diff = screen.getByTestId(TEST_IDS.storyDiff);
    expect(diff.textContent).toContain("periods.reverse();");
    expect(diff.textContent).toContain(
      "// Reverse to have most recent month first",
    );
  });

  it("no story prop renders no story section (table still renders)", () => {
    render(<LanternReportView report={WRITING_TRACKER_REPORT} />);
    expect(screen.queryByTestId(TEST_IDS.story)).toBeNull();
    expect(screen.getByTestId("property-table")).toBeTruthy();
  });
});
