// Feature: spec-lantern — Lantern_Report assembly property tests (task 16.2).
//
// Property-based tests for the PURE report-assembly logic in ./index.ts. Each
// test below implements EXACTLY ONE Correctness_Property from design.md, is
// tagged `Feature: spec-lantern, Property {n}: {property_text}`, and runs the
// project-wide minimum of 100 fast-check iterations (enforced globally in
// vitest.setup.ts).
//
// Properties under test (design.md §Correctness Properties):
//   - Property 22: The report lists every evaluated property with predicted
//                  and actual                       (Validates: R9.2)
//   - Property 23: The report includes counterexamples, deviations, and
//                  transitions it was given         (Validates: R9.3, R9.4, R9.5)
//   - Property 24: Empty collections produce explicit indications
//                                                    (Validates: R9.6, R9.7)
//
// assembleLanternReport is PURE: given the Comparison Engine's
// PropertyComparison[] (each pairing a LOCKED Predicted_Result with its
// Actual_Result, plus any Counterexample on `actual` and any
// Property_Transition on `transition`) and the ObservedDeviation[] Kiro
// recorded during analysis, it assembles one LanternReport — fabricating
// nothing and dropping nothing. That purity is exactly what lets these tests
// drive it directly with hand-built, randomly generated inputs.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type {
  ActualResult,
  Counterexample,
  ExecutionContext,
  ObservedDeviation,
  PropertyComparison,
  PropertyTransition,
  Verdict,
} from "@spec-lantern/types";
import { assembleLanternReport, assembleLanternReportTimed } from "./index.js";

/* -------------------------------------------------------------------------- */
/* Generators                                                                 */
/* -------------------------------------------------------------------------- */

/** A property id (opaque, non-empty). */
const propertyId = fc.string({ minLength: 1, maxLength: 24 });

/** A PASS/FAIL verdict. */
const verdict: fc.Arbitrary<Verdict> = fc.constantFrom("PASS", "FAIL");

/** A predicted verdict that may be absent (null => no locked prediction). */
const predicted: fc.Arbitrary<Verdict | null> = fc.option(verdict, {
  nil: null,
});

/** A reproducible Execution_Context, bundled onto every Counterexample. */
const executionContext: fc.Arbitrary<ExecutionContext> = fc.record({
  randomSeed: fc.integer(),
  timezone: fc.constantFrom("UTC", "Asia/Tokyo", "America/New_York"),
  fixedCurrentTime: fc
    .date({
      min: new Date("2000-01-01T00:00:00Z"),
      max: new Date("2100-01-01T00:00:00Z"),
    })
    .map((d) => d.toISOString()),
});

/** A Counterexample for a given property id. */
function counterexampleFor(id: string): fc.Arbitrary<Counterexample> {
  return fc.record({
    propertyId: fc.constant(id),
    input: fc.jsonValue(),
    observedOutput: fc.jsonValue(),
    executionContext,
  });
}

/**
 * A FAIL VERDICT ActualResult for `id` that optionally carries a Counterexample
 * (mirroring the runner's behavior, R5.6). A FAIL is the only outcome the
 * Comparison Engine classifies as a Confirmed_Bug (R7.3).
 */
function failResult(id: string): fc.Arbitrary<ActualResult> {
  return fc
    .option(counterexampleFor(id), { nil: undefined })
    .map<ActualResult>((ce) => ({
      propertyId: id,
      outcome: "VERDICT",
      verdict: "FAIL",
      ...(ce ? { counterexample: ce } : {}),
    }));
}

/** A PASS VERDICT ActualResult for `id` (never carries a Counterexample). */
function passResult(id: string): fc.Arbitrary<ActualResult> {
  return fc.constant<ActualResult>({
    propertyId: id,
    outcome: "VERDICT",
    verdict: "PASS",
  });
}

/** A TIMEOUT ActualResult for `id`. */
function timeoutResult(id: string): fc.Arbitrary<ActualResult> {
  return fc.integer({ min: 1, max: 600 }).map<ActualResult>((limitSeconds) => ({
    propertyId: id,
    outcome: "TIMEOUT",
    limitSeconds,
  }));
}

/** A non-verdict, non-timeout ActualResult (execution error / unavailable / safety). */
function nonVerdictNonTimeoutResult(id: string): fc.Arbitrary<ActualResult> {
  const reason = fc.string({ minLength: 1, maxLength: 40 });
  return fc.oneof(
    reason.map<ActualResult>((r) => ({
      propertyId: id,
      outcome: "EXECUTION_ERROR",
      reason: r,
    })),
    reason.map<ActualResult>((r) => ({
      propertyId: id,
      outcome: "RUNNER_UNAVAILABLE",
      reason: r,
    })),
    reason.map<ActualResult>((r) => ({
      propertyId: id,
      outcome: "SAFETY_VIOLATION",
      reason: r,
    })),
  );
}

/** A recorded Property_Transition for `id` (Revive loop output, R8.4). */
function transitionFor(id: string): fc.Arbitrary<PropertyTransition> {
  return fc
    .record({
      preFixResult: verdict,
      postFixResult: verdict,
    })
    .map<PropertyTransition>(({ preFixResult, postFixResult }) => {
      const classification =
        preFixResult === "FAIL" && postFixResult === "PASS"
          ? "FIXED"
          : preFixResult === "FAIL" && postFixResult === "FAIL"
            ? "NOT_RESOLVED"
            : preFixResult === "PASS" && postFixResult === "FAIL"
              ? "REGRESSION"
              : "STILL_PASSING";
      return { propertyId: id, preFixResult, postFixResult, classification };
    });
}

/**
 * A valid PropertyComparison whose `status` and `confirmedBug` are consistent
 * with the Comparison Engine's contract (R7): a FAIL actual is the only
 * Confirmed_Bug; a TIMEOUT is NOT_COMPARED_TIMEOUT; a non-verdict/non-timeout
 * is NOT_EXECUTED; a PASS/FAIL verdict is MATCH or PREDICTION_MISMATCH relative
 * to the (possibly null) prediction. A Property_Transition may optionally ride
 * along on `transition`.
 */
const propertyComparison: fc.Arbitrary<PropertyComparison> = propertyId.chain(
  (id) =>
    fc
      .record({
        pred: predicted,
        actual: fc.oneof(
          passResult(id),
          failResult(id),
          timeoutResult(id),
          nonVerdictNonTimeoutResult(id),
        ),
        transition: fc.option(transitionFor(id), { nil: undefined }),
      })
      .map<PropertyComparison>(({ pred, actual, transition }) => {
        let status: PropertyComparison["status"];
        let confirmedBug = false;
        if (actual.outcome === "VERDICT") {
          confirmedBug = actual.verdict === "FAIL";
          status = pred === actual.verdict ? "MATCH" : "PREDICTION_MISMATCH";
        } else if (actual.outcome === "TIMEOUT") {
          status = "NOT_COMPARED_TIMEOUT";
        } else {
          status = "NOT_EXECUTED";
        }
        return {
          propertyId: id,
          predicted: pred,
          actual,
          status,
          confirmedBug,
          ...(transition ? { transition } : {}),
        };
      }),
);

/** A list of PropertyComparison (one per evaluated property), possibly empty. */
const comparisons = fc.array(propertyComparison, { maxLength: 8 });

/** An Observed_Deviation recorded during analysis (R2). */
const observedDeviation: fc.Arbitrary<ObservedDeviation> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }),
  claimId: fc.string({ minLength: 1, maxLength: 24 }),
  claimedBehavior: fc.string({ minLength: 1, maxLength: 60 }),
  currentBehavior: fc.option(fc.string({ minLength: 1, maxLength: 60 }), {
    nil: null,
  }),
});

/** A list of Observed_Deviations, possibly empty. */
const observedDeviations = fc.array(observedDeviation, { maxLength: 8 });

/* -------------------------------------------------------------------------- */
/* Property 22                                                                */
/* -------------------------------------------------------------------------- */

describe("Lantern_Report assembly — report properties (task 16.2)", () => {
  it("Feature: spec-lantern, Property 22: The report lists every evaluated property with predicted and actual", () => {
    fc.assert(
      fc.property(comparisons, observedDeviations, (cmps, devs) => {
        const report = assembleLanternReport(cmps, devs);

        // Exactly one comparison entry per evaluated property — neither dropped
        // nor fabricated (R9.2).
        expect(report.comparisons).toHaveLength(cmps.length);

        // In order, each preserving its predicted and actual unchanged.
        for (let i = 0; i < cmps.length; i++) {
          expect(report.comparisons[i].propertyId).toBe(cmps[i].propertyId);
          expect(report.comparisons[i].predicted).toBe(cmps[i].predicted);
          expect(report.comparisons[i].actual).toStrictEqual(cmps[i].actual);
        }

        // The whole list is preserved structurally (nothing added or lost).
        expect(report.comparisons).toStrictEqual(cmps);
      }),
    );
  });

  /* ------------------------------------------------------------------------ */
  /* Property 23                                                              */
  /* ------------------------------------------------------------------------ */

  it("Feature: spec-lantern, Property 23: The report includes counterexamples, deviations, and transitions it was given", () => {
    fc.assert(
      fc.property(comparisons, observedDeviations, (cmps, devs) => {
        const report = assembleLanternReport(cmps, devs);

        for (let i = 0; i < cmps.length; i++) {
          const input = cmps[i];
          const out = report.comparisons[i];

          // Counterexample (R9.3): a Confirmed_Bug's Counterexample rides along
          // on `actual` verbatim — never re-derived or stripped.
          if (
            input.actual.outcome === "VERDICT" &&
            input.actual.verdict === "FAIL" &&
            input.actual.counterexample
          ) {
            expect(input.confirmedBug).toBe(true);
            expect(out.actual.outcome).toBe("VERDICT");
            if (out.actual.outcome === "VERDICT") {
              expect(out.actual.counterexample).toStrictEqual(
                input.actual.counterexample,
              );
            }
          }

          // Property_Transition (R9.5): preserved on `transition` verbatim,
          // carrying its Pre_Fix_Result and Post_Fix_Result.
          if (input.transition) {
            expect(out.transition).toStrictEqual(input.transition);
            expect(out.transition?.preFixResult).toBe(
              input.transition.preFixResult,
            );
            expect(out.transition?.postFixResult).toBe(
              input.transition.postFixResult,
            );
          } else {
            expect(out.transition).toBeUndefined();
          }
        }

        // Observed_Deviations (R9.4): listed as given, in order, unchanged.
        expect(report.observedDeviations).toHaveLength(devs.length);
        expect(report.observedDeviations).toStrictEqual(devs);
      }),
    );
  });

  /* ------------------------------------------------------------------------ */
  /* Property 24                                                              */
  /* ------------------------------------------------------------------------ */

  it("Feature: spec-lantern, Property 24: Empty collections produce explicit indications", () => {
    fc.assert(
      fc.property(comparisons, observedDeviations, (cmps, devs) => {
        const report = assembleLanternReport(cmps, devs);

        const anyConfirmedBug = cmps.some((c) => c.confirmedBug === true);

        // R9.6: noConfirmedBug is true iff NO comparison is a Confirmed_Bug.
        expect(report.noConfirmedBug).toBe(!anyConfirmedBug);

        // R9.7: noObservedDeviation is true iff the deviation list is empty.
        expect(report.noObservedDeviation).toBe(devs.length === 0);

        // The timed entry point produces the same explicit indications.
        const timed = assembleLanternReportTimed(cmps, devs);
        expect(timed.report.noConfirmedBug).toBe(!anyConfirmedBug);
        expect(timed.report.noObservedDeviation).toBe(devs.length === 0);
      }),
    );
  });
});
