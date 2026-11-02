// Feature: spec-lantern — execution orchestrator wiring (task 10.1)
//
// Unit tests for the gate → runner → collect orchestration. These are NOT
// fast-check properties (the safety-gate properties live in task 8.3); they are
// targeted example tests that the orchestrator:
//   - runs the Safety Gate BEFORE dispatch and returns SAFETY_VIOLATION without
//     ever creating/using a runner for a host-bound request (R5.2, R12.1,
//     R12.4);
//   - dispatches each accepted property through the Isolated_Runner contract and
//     returns a VERDICT (PASS/FAIL) on normal completion (R5.1, R5.3, R5.5);
//   - surfaces the runner's own non-verdict outcomes (e.g. RUNNER_UNAVAILABLE)
//     unchanged, never falling back to the host (R5.8, R12.5).
//
// A FAKE IsolatedRunner is injected so the wiring is exercised deterministically
// without Podman or a container. The runner-dispatch/install-topology smoke
// test against real Podman is task 10.5.

import { describe, expect, it } from "vitest";
import type {
  ActualResult,
  CorrectnessProperty,
  ExecutionContext,
  PropertyExecutionRequest,
} from "@spec-lantern/types";
import type {
  IsolatedRunner,
  IsolatedRunnerRequest,
} from "../runner/isolated-runner.js";
import { executeProperties } from "./index.js";

/** Minimal valid Correctness_Property for a function-kind claim. */
function makeProperty(id: string): CorrectnessProperty {
  return {
    id,
    claimId: id.replace(/^property-\d+\./, ""),
    title: `property ${id}`,
    statement: "for all inputs, the behavior holds",
    kind: "function",
    validatesRequirements: ["5.1"],
  };
}

/**
 * A fake Isolated_Runner that records every request and returns a scripted
 * ActualResult per propertyId (defaulting to a PASS verdict). Lets a test assert
 * both WHAT was dispatched and that the gate decides whether dispatch happens.
 *
 * This fake implements ONLY `runProperty` (not the context-aware channel) so it
 * also exercises the orchestrator's FAIL-Counterexample context fallback.
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

/**
 * A fake context-aware Isolated_Runner (task 10.3). It records a per-execution
 * Execution_Context for EVERY propertyId and returns it alongside a scripted
 * ActualResult via `runPropertyWithContext`. Mirrors the real Podman runner's
 * context channel so the orchestrator's per-execution recording (R6.1) is
 * exercised deterministically without a container.
 */
function contextRecordingRunner(
  scripted: Record<string, ActualResult> = {},
  contexts: Record<string, ExecutionContext> = {},
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
    async runPropertyWithContext(request: IsolatedRunnerRequest) {
      const result = await this.runProperty(request);
      const executionContext: ExecutionContext = contexts[request.propertyId] ?? {
        randomSeed: 1,
        timezone: "UTC",
        fixedCurrentTime: "2025-01-01T00:00:00.000Z",
      };
      return { result, executionContext };
    },
  };
}

describe("executeProperties — orchestrator wiring (task 10.1)", () => {
  it("dispatches each accepted property to the runner and returns VERDICTs in order", async () => {
    const runner = fakeRunner({
      "property-1.claim-a": {
        propertyId: "property-1.claim-a",
        outcome: "VERDICT",
        verdict: "FAIL",
      },
      "property-2.claim-b": {
        propertyId: "property-2.claim-b",
        outcome: "VERDICT",
        verdict: "PASS",
      },
    });

    const request: PropertyExecutionRequest = {
      targetRepoRef: "target-repo-copy-abc",
      properties: [makeProperty("property-1.claim-a"), makeProperty("property-2.claim-b")],
      phase: "initial",
    };

    const result = await executeProperties(request, { runner });

    // One VERDICT per property, in request order.
    expect(result.results).toEqual([
      { propertyId: "property-1.claim-a", outcome: "VERDICT", verdict: "FAIL" },
      { propertyId: "property-2.claim-b", outcome: "VERDICT", verdict: "PASS" },
    ]);

    // Each property was dispatched to the runner, mounting ONLY the target ref,
    // with the property-id-derived test file (run in place inside the mount).
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toMatchObject({
      propertyId: "property-1.claim-a",
      targetRepoPath: "target-repo-copy-abc",
      propertyTestFile: "property-1.claim-a.test.ts",
    });
    expect(runner.calls[1]?.propertyId).toBe("property-2.claim-b");
  });

  it("rejects a host-bound request at the Safety Gate and NEVER creates/uses a runner", async () => {
    const runner = fakeRunner();

    const request: PropertyExecutionRequest = {
      // host: scheme → the gate classifies this as HOST_TARGET_REFERENCE.
      targetRepoRef: "host:/Users/me/project",
      properties: [makeProperty("property-1.claim-a")],
      phase: "initial",
    };

    const result = await executeProperties(request, { runner });

    // The runner was never touched — the gate rejected before dispatch.
    expect(runner.calls).toHaveLength(0);

    // One SAFETY_VIOLATION per property, reusing the closed ActualResult union.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.outcome).toBe("SAFETY_VIOLATION");
    expect(result.results[0]?.propertyId).toBe("property-1.claim-a");
  });

  it("rejects an empty/blank target reference before dispatch", async () => {
    const runner = fakeRunner();
    const request: PropertyExecutionRequest = {
      targetRepoRef: "   ",
      properties: [makeProperty("property-1.claim-a")],
      phase: "initial",
    };

    const result = await executeProperties(request, { runner });

    expect(runner.calls).toHaveLength(0);
    expect(result.results[0]?.outcome).toBe("SAFETY_VIOLATION");
  });

  it("surfaces the runner's non-verdict outcome unchanged (no host fallback)", async () => {
    const runner = fakeRunner({
      "property-1.claim-a": {
        propertyId: "property-1.claim-a",
        outcome: "RUNNER_UNAVAILABLE",
        reason: "podman engine is not usable",
      },
    });
    const request: PropertyExecutionRequest = {
      targetRepoRef: "target-repo-copy-abc",
      properties: [makeProperty("property-1.claim-a")],
      phase: "initial",
    };

    const result = await executeProperties(request, { runner });

    expect(runner.calls).toHaveLength(1);
    expect(result.results[0]).toEqual({
      propertyId: "property-1.claim-a",
      outcome: "RUNNER_UNAVAILABLE",
      reason: "podman engine is not usable",
    });
  });

  it("surfaces the Execution_Context bundled with a FAIL Counterexample", async () => {
    const executionContext = {
      randomSeed: 42,
      timezone: "UTC",
      fixedCurrentTime: "2025-01-01T00:00:00.000Z",
    };
    const runner = fakeRunner({
      "property-1.claim-a": {
        propertyId: "property-1.claim-a",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample: {
          propertyId: "property-1.claim-a",
          input: { month: "Jan" },
          observedOutput: "oldest-first",
          executionContext,
        },
      },
    });
    const request: PropertyExecutionRequest = {
      targetRepoRef: "target-repo-copy-abc",
      properties: [makeProperty("property-1.claim-a")],
      phase: "initial",
    };

    const result = await executeProperties(request, { runner });

    expect(result.executionContexts["property-1.claim-a"]).toEqual(
      executionContext,
    );
  });

  // ---- task 10.3: per-execution Execution_Context recording (R6.1/R6.2) ----

  it("surfaces the recorded Execution_Context for EVERY execution — including PASS (R6.1)", async () => {
    const passContext: ExecutionContext = {
      randomSeed: 777,
      timezone: "UTC",
      fixedCurrentTime: "2025-06-01T00:00:00.000Z",
    };
    const failContext: ExecutionContext = {
      randomSeed: 888,
      timezone: "UTC",
      fixedCurrentTime: "2025-07-01T00:00:00.000Z",
    };
    const runner = contextRecordingRunner(
      {
        // A PASS with NO counterexample — its context can only reach the map via
        // the recorded-context channel, not a Counterexample.
        "property-1.claim-a": {
          propertyId: "property-1.claim-a",
          outcome: "VERDICT",
          verdict: "PASS",
        },
        "property-2.claim-b": {
          propertyId: "property-2.claim-b",
          outcome: "VERDICT",
          verdict: "FAIL",
        },
      },
      {
        "property-1.claim-a": passContext,
        "property-2.claim-b": failContext,
      },
    );

    const request: PropertyExecutionRequest = {
      targetRepoRef: "target-repo-copy-abc",
      properties: [
        makeProperty("property-1.claim-a"),
        makeProperty("property-2.claim-b"),
      ],
      phase: "initial",
    };

    const result = await executeProperties(request, { runner });

    // Every execution — the PASS included — has its recorded context surfaced.
    expect(result.executionContexts["property-1.claim-a"]).toEqual(passContext);
    expect(result.executionContexts["property-2.claim-b"]).toEqual(failContext);
  });

  it("records a context for a non-verdict outcome too (TIMEOUT), R6.1", async () => {
    const timeoutContext: ExecutionContext = {
      randomSeed: 5,
      timezone: "UTC",
      fixedCurrentTime: "2025-01-01T00:00:00.000Z",
    };
    const runner = contextRecordingRunner(
      {
        "property-1.claim-a": {
          propertyId: "property-1.claim-a",
          outcome: "TIMEOUT",
          limitSeconds: 30,
        },
      },
      { "property-1.claim-a": timeoutContext },
    );
    const request: PropertyExecutionRequest = {
      targetRepoRef: "target-repo-copy-abc",
      properties: [makeProperty("property-1.claim-a")],
      phase: "initial",
    };

    const result = await executeProperties(request, { runner });

    // A TIMEOUT carries no Counterexample, yet the recorded context is surfaced.
    expect(result.results[0]?.outcome).toBe("TIMEOUT");
    expect(result.executionContexts["property-1.claim-a"]).toEqual(
      timeoutContext,
    );
  });

  it("a FAIL Counterexample carries the SAME context surfaced on the map (R6.2)", async () => {
    const ctx: ExecutionContext = {
      randomSeed: 2025,
      timezone: "UTC",
      fixedCurrentTime: "2000-01-01T00:00:00.000Z",
    };
    // The runner reports the recorded context AND a FAIL whose Counterexample
    // bundles the same context — modeling the real runner handing one context
    // object to both channels.
    const runner = contextRecordingRunner(
      {
        "property-1.claim-a": {
          propertyId: "property-1.claim-a",
          outcome: "VERDICT",
          verdict: "FAIL",
          counterexample: {
            propertyId: "property-1.claim-a",
            input: { now: "Jan 2000" },
            observedOutput: "Aug 1999",
            executionContext: ctx,
          },
        },
      },
      { "property-1.claim-a": ctx },
    );
    const request: PropertyExecutionRequest = {
      targetRepoRef: "target-repo-copy-abc",
      properties: [makeProperty("property-1.claim-a")],
      phase: "initial",
    };

    const result = await executeProperties(request, { runner });

    const fail = result.results[0];
    expect(fail?.outcome).toBe("VERDICT");
    // The Counterexample's attached context (R6.2) matches the map entry (R6.1).
    const mapped = result.executionContexts["property-1.claim-a"];
    expect(mapped).toEqual(ctx);
    if (fail?.outcome === "VERDICT" && fail.counterexample) {
      expect(fail.counterexample.executionContext).toEqual(mapped);
    }
  });
});
