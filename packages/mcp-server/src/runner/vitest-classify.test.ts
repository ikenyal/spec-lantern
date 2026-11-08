// Feature: spec-lantern — execution-outcome surfacing unit tests (task 10.2)
//
// These are fast, OFFLINE, EXAMPLE-BASED unit tests for the runner's outcome
// classification — the layer that enriches the runner's test-phase result into
// the closed `ActualResult` union so Counterexample / TIMEOUT / EXECUTION_ERROR
// are each surfaced as their own shape (task 10.2, R5.6 / R5.7 / R5.9).
//
// They exercise the two PURE seams the container-backed test phase funnels every
// outcome through, so the three outcome shapes can be asserted deterministically
// WITHOUT a live Podman engine (the heavy container slice is the opt-in task 4.4
// smoke test / task 10.5 integration test):
//
//   - `parseVitestJson` — turns Vitest's `--reporter=json` output into an
//     ActualResult. This is where a genuine assertion FAIL becomes a VERDICT
//     FAIL carrying a Counterexample (triggering input + observed output), and
//     where a thrown non-assertion error / load failure / unparseable report
//     becomes an EXECUTION_ERROR with a reason (never a verdict).
//   - `applyTimeoutLimit` — stamps a TIMEOUT with the execution timeout actually
//     in effect, replacing the classifier's sentinel. This is where the
//     "TIMEOUT carries the limit in effect, never a hard-coded literal" (R5.7)
//     guarantee lives, for both the runner's wall-clock timeout and a
//     Vitest-reported per-test/hook timeout.
//
// The overriding discipline under test: timeouts and execution errors are NEVER
// encoded as PASS/FAIL. Each test asserts both the outcome tag AND that no
// verdict leaked.

import { describe, expect, it } from "vitest";
import type { ActualResult, ExecutionContext } from "@spec-lantern/types";
import { applyTimeoutLimit, parseVitestJson } from "./vitest-classify.js";

const PROPERTY_ID = "property-1.claim-monthly-order";

/** A pinned Execution_Context so a FAIL Counterexample is self-describing. */
const CTX: ExecutionContext = {
  randomSeed: 42,
  timezone: "UTC",
  fixedCurrentTime: "2025-01-01T00:00:00.000Z",
};

/**
 * Build a minimal Vitest `--reporter=json` report around a single test result.
 * Only the fields the classifier reads are populated; this keeps each fixture
 * focused on the one outcome shape it is proving.
 */
function report(fields: {
  numTotalTests?: number;
  numFailedTests?: number;
  numPassedTests?: number;
  numFailedTestSuites?: number;
  testResults?: Array<{
    status?: string;
    message?: string;
    assertionResults?: Array<{ status?: string; failureMessages?: string[] }>;
  }>;
}): string {
  return JSON.stringify(fields);
}

describe("parseVitestJson — FAIL carries a Counterexample (task 10.2, R5.6)", () => {
  // A genuine assertion failure, as fast-check 3.x emits it: the wrapper header,
  // the shrunk Counterexample line (the triggering input), and the inner
  // "Got AssertionError:" with the property's custom expected/actual message.
  const fastCheckAssertionFailure = [
    "Error: Property failed after 3 tests",
    "{ seed: 42, path: \"2:1\", endOnFailure: true }",
    "Counterexample: [[\"Aug 1999\",\"Jan 2000\"]]",
    "Shrunk 2 time(s)",
    "Got AssertionError: expected first row: Jan 2000, actual first row: Aug 1999: expected 'Aug 1999' to be 'Jan 2000'",
  ].join("\n");

  it("maps an assertion failure to a VERDICT FAIL with input + observed output", () => {
    const result = parseVitestJson(
      PROPERTY_ID,
      report({
        numTotalTests: 1,
        numFailedTests: 1,
        numPassedTests: 0,
        testResults: [
          {
            status: "failed",
            assertionResults: [
              { status: "failed", failureMessages: [fastCheckAssertionFailure] },
            ],
          },
        ],
      }),
      "",
      CTX,
    );

    expect(result.outcome).toBe("VERDICT");
    // Narrow to the VERDICT shape.
    if (result.outcome !== "VERDICT") throw new Error("expected VERDICT");
    expect(result.verdict).toBe("FAIL");

    // R5.6: the FAIL carries a Counterexample with the triggering input values…
    const cx = result.counterexample;
    expect(cx).toBeDefined();
    expect(cx?.propertyId).toBe(PROPERTY_ID);
    expect(cx?.input).toBeDefined();
    // The classifier extracts the fast-check shrunk-counterexample PAYLOAD (the
    // triggering input values printed after "Counterexample:"), not the label.
    expect(String(cx?.input)).toContain("Aug 1999");
    expect(String(cx?.input)).toContain("Jan 2000");

    // …and the observed output (what the code actually produced).
    expect(typeof cx?.observedOutput).toBe("string");
    expect(String(cx?.observedOutput)).toContain("actual first row: Aug 1999");

    // …bundling the Execution_Context so the FAIL is replayable (R6.2 seam).
    expect(cx?.executionContext).toEqual(CTX);
  });
});

describe("parseVitestJson — uncaught error / load failure → EXECUTION_ERROR (task 10.2, R5.9)", () => {
  // Precedence guard shared by every case below: an execution error must NEVER
  // be folded into PASS/FAIL.
  function expectExecutionError(result: ActualResult): void {
    expect(result.outcome).toBe("EXECUTION_ERROR");
    expect(result.outcome).not.toBe("VERDICT");
    if (result.outcome !== "EXECUTION_ERROR") throw new Error("expected error");
    expect(result.propertyId).toBe(PROPERTY_ID);
    expect(result.reason.length).toBeGreaterThan(0);
  }

  it("maps a module-load / suite-load failure (no assertions) to EXECUTION_ERROR", () => {
    const result = parseVitestJson(
      PROPERTY_ID,
      report({
        numTotalTests: 0,
        numFailedTests: 0,
        numFailedTestSuites: 1,
        testResults: [
          {
            status: "failed",
            message: "Cannot find module '@/integrations/supabase/client'",
            assertionResults: [],
          },
        ],
      }),
      "",
      CTX,
    );

    expectExecutionError(result);
    if (result.outcome !== "EXECUTION_ERROR") throw new Error("unreachable");
    expect(result.reason).toContain("failed to load");
  });

  it("maps a thrown non-assertion error to EXECUTION_ERROR, not FAIL", () => {
    // fast-check wrapping a THROWN error emits "Got error:" (not
    // "Got AssertionError:"), so this is an error, not a contradiction.
    const thrown = [
      "Error: Property failed after 1 tests",
      "Counterexample: [[]]",
      "Got error: TypeError: Cannot read properties of null (reading 'label')",
    ].join("\n");

    const result = parseVitestJson(
      PROPERTY_ID,
      report({
        numTotalTests: 1,
        numFailedTests: 1,
        numPassedTests: 0,
        testResults: [
          {
            status: "failed",
            assertionResults: [{ status: "failed", failureMessages: [thrown] }],
          },
        ],
      }),
      "",
      CTX,
    );

    expectExecutionError(result);
    if (result.outcome !== "EXECUTION_ERROR") throw new Error("unreachable");
    expect(result.reason).toContain("non-assertion error");
  });

  it("maps an unparseable Vitest report to EXECUTION_ERROR", () => {
    const result = parseVitestJson(
      PROPERTY_ID,
      "this is not JSON",
      "npx: vitest not found",
      CTX,
    );
    expectExecutionError(result);
  });
});

describe("applyTimeoutLimit — TIMEOUT carries the limit in effect (task 10.2, R5.7)", () => {
  it("rewrites the classifier's sentinel limit with the configured per-run limit", () => {
    // A Vitest-reported per-test timeout classifies to TIMEOUT with the sentinel
    // limitSeconds=0; the runner stamps it with the real configured limit.
    const vitestTimeout = parseVitestJson(
      PROPERTY_ID,
      report({
        numTotalTests: 1,
        numFailedTests: 1,
        numPassedTests: 0,
        testResults: [
          {
            status: "failed",
            assertionResults: [
              {
                status: "failed",
                failureMessages: ["Error: Test timed out in 5000ms."],
              },
            ],
          },
        ],
      }),
      "",
      CTX,
    );

    expect(vitestTimeout.outcome).toBe("TIMEOUT");
    if (vitestTimeout.outcome !== "TIMEOUT") throw new Error("expected TIMEOUT");
    // Sentinel before stamping.
    expect(vitestTimeout.limitSeconds).toBe(0);

    const stamped = applyTimeoutLimit(vitestTimeout, 30);
    expect(stamped.outcome).toBe("TIMEOUT");
    if (stamped.outcome !== "TIMEOUT") throw new Error("expected TIMEOUT");
    // The limit actually in effect — not the sentinel, and not a literal.
    expect(stamped.limitSeconds).toBe(30);
    // …and no verdict leaked.
    expect(stamped.outcome).not.toBe("VERDICT");
  });

  it("stamps whatever configured limit it is given (never a hard-coded constant)", () => {
    // Prove the limit is the one in effect, not a baked-in 30: a run configured
    // with a 7s ceiling must report 7.
    const sentinel: ActualResult = {
      propertyId: PROPERTY_ID,
      outcome: "TIMEOUT",
      limitSeconds: 0,
    };
    expect(applyTimeoutLimit(sentinel, 7)).toEqual({
      propertyId: PROPERTY_ID,
      outcome: "TIMEOUT",
      limitSeconds: 7,
    });
  });

  it("is a no-op for non-TIMEOUT outcomes (pass-through)", () => {
    const verdict: ActualResult = {
      propertyId: PROPERTY_ID,
      outcome: "VERDICT",
      verdict: "PASS",
    };
    const error: ActualResult = {
      propertyId: PROPERTY_ID,
      outcome: "EXECUTION_ERROR",
      reason: "boom",
    };
    // Identical object back — the limit is only meaningful for a TIMEOUT.
    expect(applyTimeoutLimit(verdict, 30)).toEqual(verdict);
    expect(applyTimeoutLimit(error, 30)).toEqual(error);
  });
});

describe("parseVitestJson — both fast-check failure styles are a VERDICT FAIL (regression: packaged-power run)", () => {
  // Helper: wrap a single fast-check failure message as the one failing
  // assertion in an otherwise-minimal Vitest JSON report, and classify it.
  function classifyFailure(failureMessage: string): ActualResult {
    return parseVitestJson(
      PROPERTY_ID,
      report({
        numTotalTests: 1,
        numFailedTests: 1,
        numPassedTests: 0,
        testResults: [
          {
            status: "failed",
            assertionResults: [
              { status: "failed", failureMessages: [failureMessage] },
            ],
          },
        ],
      }),
      "",
      CTX,
    );
  }

  function expectFailWithCounterexample(
    result: ActualResult,
    expectedInputFragment: string,
  ): void {
    expect(result.outcome).toBe("VERDICT");
    // An EXECUTION_ERROR here would be the exact regression this guards against.
    expect(result.outcome).not.toBe("EXECUTION_ERROR");
    if (result.outcome !== "VERDICT") throw new Error("expected VERDICT");
    expect(result.verdict).toBe("FAIL");

    const cx = result.counterexample;
    expect(cx).toBeDefined();
    expect(cx?.propertyId).toBe(PROPERTY_ID);
    // The shrunk Counterexample payload (triggering input) is extracted from
    // fast-check's "Counterexample:" line.
    expect(String(cx?.input)).toContain(expectedInputFragment);
    // The seed that drove the run is bundled for exact replay (R6.2). It is the
    // recorded Execution_Context seed, which is what fast-check was configured
    // with and what its report echoes back.
    expect(cx?.executionContext).toEqual(CTX);
    expect(cx?.executionContext.randomSeed).toBe(42);
  }

  // Style 1 — fc.assert(fc.property(..., () => expect(...).toBe(...))): the
  // predicate THROWS a vitest/chai AssertionError, which fast-check re-emits as
  // "Got AssertionError:". Already classified correctly; kept as a guard so the
  // two styles live side by side.
  it("fc.assert + expect() (assertion throw) → VERDICT FAIL with counterexample", () => {
    const fcAssertExpect = [
      "Error: Property failed after 3 tests",
      '{ seed: 42, path: "2:1", endOnFailure: true }',
      'Counterexample: [{"closeHour":0,"closeMinute":24,"minutesUntilClose":721}]',
      "Shrunk 2 time(s)",
      "Got AssertionError: expected '00:24' to be null // Object.is equality",
    ].join("\n");

    const result = classifyFailure(fcAssertExpect);
    expectFailWithCounterexample(result, '"closeHour":0');
    if (result.outcome !== "VERDICT") throw new Error("unreachable");
    // The readable observed output surfaces the expected/actual, not the stack.
    expect(String(result.counterexample?.observedOutput)).toContain("expected");
  });

  // Style 2 — fc.assert(fc.property(..., (x) => predicate(x))): the predicate
  // REPORTS FALSITY BY RETURNING false (the other canonical fast-check idiom).
  // fast-check does not wrap a user error; it synthesizes
  // "Got error: Property failed by returning false". This is the regression a
  // real packaged-power run hit — it was misclassified as EXECUTION_ERROR
  // because the message contains "Got error:" and no "AssertionError". It MUST
  // be a VERDICT FAIL, carrying the shrunk counterexample.
  it("fc.assert returning false (boolean predicate) → VERDICT FAIL with counterexample", () => {
    const fcBooleanFalse = [
      "Error: Property failed after 1 tests",
      '{ seed: 42, path: "0:0", endOnFailure: true }',
      "Counterexample: [0]",
      "Shrunk 1 time(s)",
      "Got error: Property failed by returning false",
      "",
      "Hint: Enable verbose mode in order to have the list of all failing values encountered during the run",
    ].join("\n");

    const result = classifyFailure(fcBooleanFalse);
    expectFailWithCounterexample(result, "0");
    if (result.outcome !== "VERDICT") throw new Error("unreachable");
    // Observed output names what happened rather than echoing the opaque
    // "Property failed after N tests" wrapper header.
    expect(String(result.counterexample?.observedOutput)).toContain(
      "property returned false",
    );
  });

  // fc.check + expect(result.failed).toBe(false): here the TOP-LEVEL throw is a
  // plain vitest AssertionError ("expected true to be false") with NO
  // fast-check "Property failed after" wrapper — the fc.check result object was
  // asserted on directly. It is still a genuine assertion FAIL.
  it("fc.check + expect(result.failed).toBe(false) → VERDICT FAIL", () => {
    const fcCheckExpect = [
      "AssertionError: expected true to be false // Object.is equality",
      "- Expected",
      "+ Received",
      "- false",
      "+ true",
    ].join("\n");

    const result = classifyFailure(fcCheckExpect);
    expect(result.outcome).toBe("VERDICT");
    if (result.outcome !== "VERDICT") throw new Error("expected VERDICT");
    expect(result.verdict).toBe("FAIL");
    expect(result.counterexample).toBeDefined();
  });

  // Guard the OTHER direction: a real thrown (non-assertion) error wrapped by
  // fast-check stays an EXECUTION_ERROR. "Got error:" with a real error message
  // (not the "returning false" sentinel) is NOT a prediction contradiction.
  it("fc.assert wrapping a real thrown error stays EXECUTION_ERROR (not FAIL)", () => {
    const fcThrown = [
      "Error: Property failed after 1 tests",
      '{ seed: 42, path: "0:0", endOnFailure: true }',
      "Counterexample: [[]]",
      "Got error: TypeError: Cannot read properties of null (reading 'label')",
    ].join("\n");

    const result = classifyFailure(fcThrown);
    expect(result.outcome).toBe("EXECUTION_ERROR");
    expect(result.outcome).not.toBe("VERDICT");
    if (result.outcome !== "EXECUTION_ERROR") throw new Error("expected error");
    expect(result.reason).toContain("non-assertion error");
    // The reason names the real error, not the opaque wrapper header.
    expect(result.reason).toContain("TypeError");
  });
});
