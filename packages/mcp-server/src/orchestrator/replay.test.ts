// Feature: spec-lantern — Counterexample replay wiring (task 11.1)
//
// Targeted example tests (NOT the fast-check Property 12, which is task 11.2)
// for the `replay_counterexample` path. They prove the replay orchestration:
//   - forces the recorded Execution_Context onto the runner request so the
//     replay is pinned to the original seed/timezone/Fixed_Current_Time (R6.3);
//   - routes through the SAME Safety Gate as execution, rejecting a host-bound
//     replay as SAFETY_VIOLATION without ever creating/using a runner (R5.2,
//     R12.1, R12.4);
//   - dispatches through the IsolatedRunner contract and surfaces the single
//     ActualResult unchanged — including a FAIL with its Counterexample and a
//     non-verdict RUNNER_UNAVAILABLE, never falling back to the host (R5.8,
//     R12.5);
//   - mounts ONLY the target ref and resolves the property-id-derived test file
//     (run in place inside the mount, R12.6).
//
// A FAKE IsolatedRunner is injected so the wiring is exercised deterministically
// without Podman or a container. Reproducibility against a real seeded run is
// the smoke/property surface (tasks 10.5, 11.2), not this unit test.

import { describe, expect, it } from "vitest";
import type {
  ActualResult,
  CorrectnessProperty,
  ExecutionContext,
} from "@spec-lantern/types";
import type {
  IsolatedRunner,
  IsolatedRunnerRequest,
} from "../runner/isolated-runner.js";
import { replayCounterexample } from "./replay.js";

/** Minimal valid Correctness_Property for a function-kind claim. */
function makeProperty(id: string): CorrectnessProperty {
  return {
    id,
    claimId: id.replace(/^property-\d+\./, ""),
    title: `property ${id}`,
    statement: "for all inputs, the behavior holds",
    kind: "function",
    validatesRequirements: ["6.3"],
  };
}

/**
 * A fake Isolated_Runner that records every request and returns a scripted
 * ActualResult per propertyId (defaulting to a PASS verdict). Lets a test assert
 * both WHAT was dispatched (crucially the forced Execution_Context) and that the
 * gate decides whether dispatch happens at all.
 */
function fakeRunner(
  scripted: Record<string, ActualResult> = {},
): IsolatedRunner & { calls: IsolatedRunnerRequest[] } {
  const calls: IsolatedRunnerRequest[] = [];
  return {
    calls,
    async runProperty(request: IsolatedRunnerRequest): Promise<ActualResult> {
      calls.push(request);
      return (
        scripted[request.propertyId] ?? {
          propertyId: request.propertyId,
          outcome: "VERDICT",
          verdict: "PASS",
        }
      );
    },
  };
}

const RECORDED_CONTEXT: ExecutionContext = {
  randomSeed: 123456789,
  timezone: "Asia/Tokyo",
  fixedCurrentTime: "2020-01-15T00:00:00.000Z",
};

describe("replayCounterexample — replay wiring (task 11.1)", () => {
  it("forces the recorded Execution_Context onto the runner request (R6.3)", async () => {
    const runner = fakeRunner();

    await replayCounterexample(
      {
        targetRepoRef: "target-repo-copy-abc",
        property: makeProperty("property-1.claim-monthly-order"),
        executionContext: RECORDED_CONTEXT,
      },
      // mountInPlace exercises the wiring with a symbolic ref; copy-safety is
      // covered against a real repo in working-copy.test.ts.
      { runner, mountInPlace: true },
    );

    // The property was dispatched ONCE, mounting ONLY the target ref, with the
    // property-id-derived test file run in place — and the recorded context
    // forced verbatim so the runner pins the original seed/timezone/instant.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      propertyId: "property-1.claim-monthly-order",
      targetRepoPath: "target-repo-copy-abc",
      propertyTestFile: "property-1.claim-monthly-order.test.ts",
    });
    expect(runner.calls[0]?.executionContext).toEqual(RECORDED_CONTEXT);
  });

  it("surfaces the single ActualResult unchanged — a FAIL with its Counterexample", async () => {
    const counterexample = {
      propertyId: "property-1.claim-monthly-order",
      input: { now: "Jan 2020" },
      observedOutput: "Aug 2019",
      executionContext: RECORDED_CONTEXT,
    };
    const runner = fakeRunner({
      "property-1.claim-monthly-order": {
        propertyId: "property-1.claim-monthly-order",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample,
      },
    });

    const result = await replayCounterexample(
      {
        targetRepoRef: "target-repo-copy-abc",
        property: makeProperty("property-1.claim-monthly-order"),
        executionContext: RECORDED_CONTEXT,
      },
      { runner, mountInPlace: true },
    );

    // Replay returns the ONE ActualResult (not a batch), carrying the original
    // Counterexample with the SAME Execution_Context it replayed under.
    expect(result).toEqual({
      propertyId: "property-1.claim-monthly-order",
      outcome: "VERDICT",
      verdict: "FAIL",
      counterexample,
    });
    if (result.outcome === "VERDICT" && result.counterexample) {
      expect(result.counterexample.executionContext).toEqual(RECORDED_CONTEXT);
    }
  });

  it("rejects a host-bound replay at the Safety Gate and NEVER creates/uses a runner (R12.4)", async () => {
    const runner = fakeRunner();

    const result = await replayCounterexample(
      {
        // host: scheme → the gate classifies this as a host target reference.
        targetRepoRef: "host:/Users/me/project",
        property: makeProperty("property-1.claim-monthly-order"),
        executionContext: RECORDED_CONTEXT,
      },
      { runner },
    );

    // The gate rejected before dispatch — the runner was never touched.
    expect(runner.calls).toHaveLength(0);
    expect(result.outcome).toBe("SAFETY_VIOLATION");
    expect(result.propertyId).toBe("property-1.claim-monthly-order");
  });

  it("rejects an empty/blank target reference before dispatch", async () => {
    const runner = fakeRunner();

    const result = await replayCounterexample(
      {
        targetRepoRef: "   ",
        property: makeProperty("property-1.claim-monthly-order"),
        executionContext: RECORDED_CONTEXT,
      },
      { runner },
    );

    expect(runner.calls).toHaveLength(0);
    expect(result.outcome).toBe("SAFETY_VIOLATION");
  });

  it("surfaces the runner's non-verdict outcome unchanged (no host fallback, R5.8)", async () => {
    const runner = fakeRunner({
      "property-1.claim-monthly-order": {
        propertyId: "property-1.claim-monthly-order",
        outcome: "RUNNER_UNAVAILABLE",
        reason: "podman engine is not usable",
      },
    });

    const result = await replayCounterexample(
      {
        targetRepoRef: "target-repo-copy-abc",
        property: makeProperty("property-1.claim-monthly-order"),
        executionContext: RECORDED_CONTEXT,
      },
      { runner, mountInPlace: true },
    );

    expect(runner.calls).toHaveLength(1);
    expect(result).toEqual({
      propertyId: "property-1.claim-monthly-order",
      outcome: "RUNNER_UNAVAILABLE",
      reason: "podman engine is not usable",
    });
  });
});
