// Feature: spec-lantern — Comparison Engine property tests (task 14.2).
//
// Property-based tests for the PURE comparison logic in ./index.ts. Each test
// below implements EXACTLY ONE Correctness_Property from design.md, is tagged
// `Feature: spec-lantern, Property {n}: {property_text}`, and runs the
// project-wide minimum of 100 fast-check iterations (enforced globally in
// vitest.setup.ts).
//
// Properties under test (design.md §Correctness Properties):
//   - Property 14: Prediction mismatch is flagged exactly when predicted
//                  differs from actual        (Validates: R7.1, R7.2)
//   - Property 15: FAIL classifies a Confirmed_Bug with its Counterexample;
//                  non-FAIL does not           (Validates: R7.3)
//   - Property 16: Timeout outcomes are excluded from comparison
//                                              (Validates: R7.4)
//   - Property 17: Predicted-only properties are marked not executed
//                                              (Validates: R7.5)
//
// The engine (compareProperty / compareProperties) is PURE: given a locked
// Predicted_Result verdict and an Actual_Result, it returns one classified
// PropertyComparison with no I/O and no execution. That purity is exactly what
// lets these tests drive it directly with hand-built, randomly generated inputs
// and assert the classification contract across a wide input space.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type {
  ActualResult,
  Counterexample,
  ExecutionContext,
  Verdict,
} from "@spec-lantern/types";
import { compareProperty, type ComparisonInput } from "./index.js";

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
    .date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2100-01-01T00:00:00Z") })
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
 * A VERDICT ActualResult for `id`. A FAIL may (optionally) carry a
 * Counterexample, mirroring the runner's behavior (R5.6); a PASS never does.
 */
function verdictResult(id: string): fc.Arbitrary<ActualResult> {
  return verdict.chain((v) => {
    if (v === "PASS") {
      return fc.constant<ActualResult>({
        propertyId: id,
        outcome: "VERDICT",
        verdict: "PASS",
      });
    }
    // FAIL: optionally attach a Counterexample.
    return fc
      .option(counterexampleFor(id), { nil: undefined })
      .map<ActualResult>((ce) => ({
        propertyId: id,
        outcome: "VERDICT",
        verdict: "FAIL",
        ...(ce ? { counterexample: ce } : {}),
      }));
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

/** Any ActualResult outcome for `id`. */
function anyResult(id: string): fc.Arbitrary<ActualResult> {
  return fc.oneof(
    verdictResult(id),
    timeoutResult(id),
    nonVerdictNonTimeoutResult(id),
  );
}

/** A full ComparisonInput: predicted verdict + any actual result. */
const comparisonInput: fc.Arbitrary<ComparisonInput> = propertyId.chain((id) =>
  fc.record({
    propertyId: fc.constant(id),
    predicted,
    actual: anyResult(id),
  }),
);

/* -------------------------------------------------------------------------- */
/* Property 14                                                                */
/* -------------------------------------------------------------------------- */

describe("Comparison Engine — classification properties (task 14.2)", () => {
  it("Feature: spec-lantern, Property 14: Prediction mismatch is flagged exactly when predicted differs from actual", () => {
    // Drive only the case the property quantifies over: a recorded (non-null)
    // Predicted_Result AND an actual VERDICT (PASS/FAIL). Under those
    // conditions the status is PREDICTION_MISMATCH iff predicted !== actual.
    const input = propertyId.chain((id) =>
      fc.record({
        propertyId: fc.constant(id),
        predicted: verdict, // recorded prediction (never null here)
        actual: verdictResult(id),
      }),
    );

    fc.assert(
      fc.property(input, (cmp) => {
        const result = compareProperty(cmp);
        // Guaranteed by the generator, but assert so the "iff" is meaningful.
        expect(cmp.actual.outcome).toBe("VERDICT");
        if (cmp.actual.outcome !== "VERDICT") return;

        const differ = cmp.predicted !== cmp.actual.verdict;

        // Exactly-when: mismatch flagged <=> predicted differs from actual.
        expect(result.status === "PREDICTION_MISMATCH").toBe(differ);
        if (differ) {
          expect(result.status).toBe("PREDICTION_MISMATCH");
        } else {
          expect(result.status).toBe("MATCH");
        }

        // The compared verdicts are preserved on the comparison unchanged.
        expect(result.predicted).toBe(cmp.predicted);
        expect(result.actual).toStrictEqual(cmp.actual);
      }),
    );
  });

  /* ------------------------------------------------------------------------ */
  /* Property 15                                                              */
  /* ------------------------------------------------------------------------ */

  it("Feature: spec-lantern, Property 15: FAIL classifies a Confirmed_Bug with its Counterexample; non-FAIL does not", () => {
    fc.assert(
      fc.property(comparisonInput, (cmp) => {
        const result = compareProperty(cmp);

        const isActualFail =
          cmp.actual.outcome === "VERDICT" && cmp.actual.verdict === "FAIL";

        // confirmedBug is true iff the actual verdict is FAIL (R7.3), regardless
        // of the prediction or whether a Counterexample was attached.
        expect(result.confirmedBug).toBe(isActualFail);

        // A non-FAIL outcome is NEVER a Confirmed_Bug.
        if (!isActualFail) {
          expect(result.confirmedBug).toBe(false);
        }

        // When a FAIL carried a Counterexample, it rides along on the
        // comparison's `actual` unchanged so the report can surface it.
        if (
          cmp.actual.outcome === "VERDICT" &&
          cmp.actual.verdict === "FAIL" &&
          cmp.actual.counterexample
        ) {
          expect(result.actual.outcome).toBe("VERDICT");
          if (result.actual.outcome === "VERDICT") {
            expect(result.actual.counterexample).toStrictEqual(
              cmp.actual.counterexample,
            );
            expect(result.actual.counterexample?.propertyId).toBe(
              cmp.propertyId,
            );
          }
        }
      }),
    );
  });

  /* ------------------------------------------------------------------------ */
  /* Property 16                                                              */
  /* ------------------------------------------------------------------------ */

  it("Feature: spec-lantern, Property 16: Timeout outcomes are excluded from comparison", () => {
    // A timeout, with ANY prediction (including a recorded one that could
    // otherwise mismatch), is marked not-compared and excluded from mismatch
    // flagging and Confirmed_Bug classification.
    const input = propertyId.chain((id) =>
      fc.record({
        propertyId: fc.constant(id),
        predicted, // may be PASS/FAIL/null — must not cause a comparison
        actual: timeoutResult(id),
      }),
    );

    fc.assert(
      fc.property(input, (cmp) => {
        const result = compareProperty(cmp);

        // Excluded: never a mismatch, never a match pairing — it is its own
        // distinct "not compared because of timeout" status.
        expect(result.status).toBe("NOT_COMPARED_TIMEOUT");
        expect(result.status).not.toBe("PREDICTION_MISMATCH");

        // A timeout can never be a Confirmed_Bug.
        expect(result.confirmedBug).toBe(false);

        // The timeout outcome is preserved verbatim (never rewritten to a verdict).
        expect(result.actual.outcome).toBe("TIMEOUT");
      }),
    );
  });

  /* ------------------------------------------------------------------------ */
  /* Property 17                                                              */
  /* ------------------------------------------------------------------------ */

  it("Feature: spec-lantern, Property 17: Predicted-only properties are marked not executed", () => {
    // A recorded Predicted_Result but NO PASS/FAIL Actual_Result — modeled by a
    // non-verdict, non-timeout outcome (execution error / runner unavailable /
    // safety violation), which is how "no actual result exists" surfaces. It is
    // marked NOT_EXECUTED and is neither a mismatch nor a Confirmed_Bug.
    const input = propertyId.chain((id) =>
      fc.record({
        propertyId: fc.constant(id),
        predicted: verdict, // a prediction IS recorded (predicted-only)
        actual: nonVerdictNonTimeoutResult(id),
      }),
    );

    fc.assert(
      fc.property(input, (cmp) => {
        const result = compareProperty(cmp);

        expect(result.status).toBe("NOT_EXECUTED");
        // Not paired as a mismatch…
        expect(result.status).not.toBe("PREDICTION_MISMATCH");
        // …and not classified as a Confirmed_Bug.
        expect(result.confirmedBug).toBe(false);

        // The recorded prediction is retained even though nothing executed.
        expect(result.predicted).toBe(cmp.predicted);
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Null / missing locked prediction — explicit "no locked prediction"         */
/* -------------------------------------------------------------------------- */

describe("Comparison Engine — a missing/null locked prediction (cleanup 3)", () => {
  it("classifies a real PASS/FAIL actual with NO prediction as NO_LOCKED_PREDICTION (never MATCH / PASS / FAIL)", () => {
    const input = propertyId.chain((id) =>
      fc.record({
        propertyId: fc.constant(id),
        predicted: fc.constant(null), // NO locked prediction
        actual: verdictResult(id), // a real PASS/FAIL actual exists
      }),
    );

    fc.assert(
      fc.property(input, (cmp) => {
        const result = compareProperty(cmp);

        // Explicit "no locked prediction" — NEVER a plain MATCH that reads as a
        // verified pass, and never a mismatch either.
        expect(result.status).toBe("NO_LOCKED_PREDICTION");
        expect(result.status).not.toBe("MATCH");
        expect(result.status).not.toBe("PREDICTION_MISMATCH");

        // No prediction was fabricated to fill the gap (report-data-fidelity).
        expect(result.predicted).toBeNull();

        // A FAIL actual still confirms a bug…
        const isActualFail =
          cmp.actual.outcome === "VERDICT" && cmp.actual.verdict === "FAIL";
        expect(result.confirmedBug).toBe(isActualFail);
      }),
    );
  });

  it("a FAIL actual with no prediction confirms a bug but is NOT a prediction mismatch (not a lie)", () => {
    const result = compareProperty({
      propertyId: "property-1.claim-x",
      predicted: null,
      actual: { propertyId: "property-1.claim-x", outcome: "VERDICT", verdict: "FAIL" },
    });
    expect(result.status).toBe("NO_LOCKED_PREDICTION");
    expect(result.confirmedBug).toBe(true);
    // A lie requires a locked prediction that disagreed with the actual; a
    // missing prediction can never be a PREDICTION_MISMATCH.
    expect(result.status).not.toBe("PREDICTION_MISMATCH");
  });

  it("a PASS actual with no prediction is NO_LOCKED_PREDICTION and not a confirmed bug", () => {
    const result = compareProperty({
      propertyId: "property-2.claim-y",
      predicted: null,
      actual: { propertyId: "property-2.claim-y", outcome: "VERDICT", verdict: "PASS" },
    });
    expect(result.status).toBe("NO_LOCKED_PREDICTION");
    expect(result.confirmedBug).toBe(false);
  });
});
