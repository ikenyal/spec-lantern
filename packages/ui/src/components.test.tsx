// @vitest-environment jsdom
/**
 * Smoke test for the Lantern_Report_UI rows (task 18.1).
 *
 * Covers the three 18.1 requirements at example level (the property-based
 * coverage is the optional task 18.3):
 *   - R10.1: predicted and actual cells are adjacent siblings in the same row.
 *   - R10.3: the mismatch indicator is present on a PREDICTION_MISMATCH row and
 *     absent on MATCH, NOT_COMPARED_TIMEOUT, and NOT_EXECUTED rows.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { PropertyComparison, Verdict } from "@spec-lantern/types";
import { LanternReportView, TEST_IDS } from "./index.js";

afterEach(cleanup);

function verdictActual(
  propertyId: string,
  verdict: Verdict,
): PropertyComparison["actual"] {
  return { propertyId, outcome: "VERDICT", verdict };
}

const comparisons: PropertyComparison[] = [
  {
    propertyId: "p-match",
    predicted: "PASS",
    actual: verdictActual("p-match", "PASS"),
    status: "MATCH",
    confirmedBug: false,
  },
  {
    propertyId: "p-mismatch",
    predicted: "PASS",
    actual: verdictActual("p-mismatch", "FAIL"),
    status: "PREDICTION_MISMATCH",
    confirmedBug: true,
  },
  {
    propertyId: "p-timeout",
    predicted: "PASS",
    actual: { propertyId: "p-timeout", outcome: "TIMEOUT", limitSeconds: 30 },
    status: "NOT_COMPARED_TIMEOUT",
    confirmedBug: false,
  },
  {
    propertyId: "p-notrun",
    predicted: "PASS",
    actual: {
      propertyId: "p-notrun",
      outcome: "EXECUTION_ERROR",
      reason: "not executed",
    },
    status: "NOT_EXECUTED",
    confirmedBug: false,
  },
];

const report = {
  comparisons,
  observedDeviations: [],
  noConfirmedBug: false,
  noObservedDeviation: true,
  generatedAt: "2020-01-01T00:00:00.000Z",
};

describe("LanternReportView rows (task 18.1)", () => {
  it("R10.1: predicted and actual cells are adjacent in the same row", () => {
    render(<LanternReportView report={report} />);

    for (const c of comparisons) {
      const predicted = screen.getByTestId(TEST_IDS.predicted(c.propertyId));
      const actual = screen.getByTestId(TEST_IDS.actual(c.propertyId));

      // Same row.
      expect(predicted.closest("tr")).toBe(actual.closest("tr"));
      // Adjacent: actual is the predicted cell's immediate next sibling.
      expect(predicted.nextElementSibling).toBe(actual);
    }
  });

  it("R10.3: mismatch indicator is present exactly on the mismatched row", () => {
    render(<LanternReportView report={report} />);

    expect(screen.getByTestId(TEST_IDS.mismatch("p-mismatch"))).toBeTruthy();

    for (const id of ["p-match", "p-timeout", "p-notrun"]) {
      expect(screen.queryByTestId(TEST_IDS.mismatch(id))).toBeNull();
    }
  });
});

describe("LanternReportView — a missing/null locked prediction (cleanup 3)", () => {
  const noPredictionReport = {
    comparisons: [
      {
        propertyId: "p-nolock-fail",
        predicted: null,
        actual: verdictActual("p-nolock-fail", "FAIL"),
        status: "NO_LOCKED_PREDICTION" as const,
        confirmedBug: true,
      },
      {
        propertyId: "p-nolock-pass",
        predicted: null,
        actual: verdictActual("p-nolock-pass", "PASS"),
        status: "NO_LOCKED_PREDICTION" as const,
        confirmedBug: false,
      },
    ] satisfies PropertyComparison[],
    observedDeviations: [],
    noConfirmedBug: false,
    noObservedDeviation: true,
    generatedAt: "2020-01-01T00:00:00.000Z",
  };

  it('renders an explicit "no locked prediction" indicator, never a "Match" or mismatch', () => {
    render(<LanternReportView report={noPredictionReport} />);

    for (const id of ["p-nolock-fail", "p-nolock-pass"]) {
      const indicator = screen.getByTestId(TEST_IDS.noLockedPrediction(id));
      expect(indicator).toBeTruthy();
      expect(indicator.textContent).toMatch(/no locked prediction/i);
      // Must NOT read as a verified pass/match or as a mismatch.
      expect(screen.queryByTestId(TEST_IDS.match(id))).toBeNull();
      expect(screen.queryByTestId(TEST_IDS.mismatch(id))).toBeNull();
    }
  });

  it("tags the row's data-status as NO_LOCKED_PREDICTION", () => {
    render(<LanternReportView report={noPredictionReport} />);
    const row = screen.getByTestId(TEST_IDS.row("p-nolock-fail"));
    expect(row.getAttribute("data-status")).toBe("NO_LOCKED_PREDICTION");
  });
});
/**
 * Smoke test for the Lantern_Report_UI detail + empty states (task 18.2).
 *
 * Covers the four 18.2 requirements at example level:
 *   - R10.4: a Confirmed_Bug row with a Counterexample shows its input/output.
 *   - R10.5: a row with a Property_Transition shows its pre/post-fix results.
 *   - R10.6: a Confirmed_Bug row with no Counterexample shows the "unavailable"
 *     indication (and NOT a counterexample).
 *   - R10.7: a null/undefined report shows the "no report exists" message.
 */
import type { ExecutionContext, PropertyTransition } from "@spec-lantern/types";

const executionContext: ExecutionContext = {
  randomSeed: 42,
  timezone: "Asia/Tokyo",
  fixedCurrentTime: "2020-01-01T00:00:00.000Z",
};

describe("LanternReportView detail + empty states (task 18.2)", () => {
  it("R10.4: Confirmed_Bug row renders its Counterexample input and output", () => {
    const comparison: PropertyComparison = {
      propertyId: "p-bug",
      predicted: "PASS",
      actual: {
        propertyId: "p-bug",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample: {
          propertyId: "p-bug",
          input: { month: "2019-08" },
          observedOutput: ["2019-08", "2019-09"],
          executionContext,
        },
      },
      status: "PREDICTION_MISMATCH",
      confirmedBug: true,
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

    expect(screen.getByTestId(TEST_IDS.counterexample("p-bug"))).toBeTruthy();
    expect(screen.getByTestId(TEST_IDS.counterexampleInput("p-bug")).textContent).toContain(
      '{"month":"2019-08"}',
    );
    expect(
      screen.getByTestId(TEST_IDS.counterexampleOutput("p-bug")).textContent,
    ).toContain('["2019-08","2019-09"]');
    // No unavailable indication when a counterexample IS present.
    expect(
      screen.queryByTestId(TEST_IDS.counterexampleUnavailable("p-bug")),
    ).toBeNull();
  });

  it("R10.6: Confirmed_Bug row with no Counterexample shows the unavailable indication", () => {
    const comparison: PropertyComparison = {
      propertyId: "p-nocx",
      predicted: "PASS",
      // A FAIL verdict with no counterexample attached.
      actual: { propertyId: "p-nocx", outcome: "VERDICT", verdict: "FAIL" },
      status: "PREDICTION_MISMATCH",
      confirmedBug: true,
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

    expect(
      screen.getByTestId(TEST_IDS.counterexampleUnavailable("p-nocx")),
    ).toBeTruthy();
    expect(screen.queryByTestId(TEST_IDS.counterexample("p-nocx"))).toBeNull();
  });

  it("R10.4/R10.6: a non-Confirmed_Bug row shows neither counterexample nor unavailable text", () => {
    const comparison: PropertyComparison = {
      propertyId: "p-ok",
      predicted: "PASS",
      actual: verdictActual("p-ok", "PASS"),
      status: "MATCH",
      confirmedBug: false,
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

    expect(screen.queryByTestId(TEST_IDS.counterexample("p-ok"))).toBeNull();
    expect(
      screen.queryByTestId(TEST_IDS.counterexampleUnavailable("p-ok")),
    ).toBeNull();
  });

  it("R10.5: a row with a Property_Transition shows pre-fix and post-fix results", () => {
    const transition: PropertyTransition = {
      propertyId: "p-fixed",
      preFixResult: "FAIL",
      postFixResult: "PASS",
      classification: "FIXED",
    };
    const comparison: PropertyComparison = {
      propertyId: "p-fixed",
      predicted: "PASS",
      actual: verdictActual("p-fixed", "PASS"),
      status: "MATCH",
      confirmedBug: false,
      transition,
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

    expect(screen.getByTestId(TEST_IDS.transition("p-fixed"))).toBeTruthy();
    expect(
      screen.getByTestId(TEST_IDS.transitionPreFix("p-fixed")).textContent,
    ).toContain("FAIL");
    expect(
      screen.getByTestId(TEST_IDS.transitionPostFix("p-fixed")).textContent,
    ).toContain("PASS");
    // A row without a transition renders no transition element.
    expect(screen.queryByTestId(TEST_IDS.transition("p-match"))).toBeNull();
  });

  it("R10.7: a null report shows the no-report message and no table", () => {
    render(<LanternReportView report={null} />);

    expect(screen.getByTestId(TEST_IDS.noReport)).toBeTruthy();
    expect(screen.queryByTestId("property-table")).toBeNull();
  });

  it("R10.7: an undefined report shows the no-report message", () => {
    render(<LanternReportView report={undefined} />);

    expect(screen.getByTestId(TEST_IDS.noReport)).toBeTruthy();
  });
});
