/**
 * The MCP_Server execution orchestrator (task 10.1).
 *
 * This module is the seam that turns a {@link PropertyExecutionRequest} into a
 * {@link PropertyExecutionResult} by routing it through the two host-safety
 * layers built in earlier tasks and then the runner lifecycle:
 *
 *     request
 *       │
 *       ├─▶ Safety Gate (task 8.1) ──── reject host-bound ─▶ SAFETY_VIOLATION
 *       │        │  accept (isolated_runner)
 *       │        ▼
 *       └─▶ Isolated_Runner (task 8.2 → task 9 two-phase)
 *                │  install phase (internal network + Verdaccio, --ignore-scripts)
 *                ▼  then test phase (--network none)
 *            ActualResult per property  ─▶  PropertyExecutionResult
 *
 * WHY A SEPARATE MODULE FROM THE TOOL REGISTRATION. The transport wiring
 * ({@link ../mcp-server.ts}) is only responsible for exposing the tool over the
 * MCP boundary. The actual "gate → runner → collect" orchestration is pure
 * TypeScript that a test can drive directly without standing up a transport, so
 * it lives here and the tool handler is a thin adapter over
 * {@link executeProperties}.
 *
 * HOST-SAFETY DISCIPLINE (the product's core guarantee). The orchestrator
 * UPHOLDS, and never weakens, the invariants the earlier layers established:
 *  - Every request passes through {@link classifyPropertyExecution} BEFORE any
 *    property is dispatched. A host-bound request is rejected and its
 *    per-property `SAFETY_VIOLATION` results are returned unchanged — no runner
 *    is ever created (R5.2, R12.1, R12.4).
 *  - Accepted requests are dispatched ONLY through the {@link IsolatedRunner}
 *    contract. There is no code path from the orchestrator to host execution,
 *    and the runner itself surfaces `RUNNER_UNAVAILABLE` rather than falling
 *    back to the host when Podman is absent (R5.3, R5.8, R12.5).
 *  - The runner runs the Dependency_Install_Phase fully before the
 *    Test_Execution_Phase (R5.4, R12.2, R12.3); that ordering is owned by
 *    `runTwoPhase` and the orchestrator does not reorder or skip it.
 *  - Results stay inside the closed `ActualResult` union. Normal completion is a
 *    `VERDICT` (exactly PASS or FAIL); the orchestrator never invents a bespoke
 *    outcome shape.
 *
 * SCOPE. Task 10.1 wired the transport + tool and the NORMAL VERDICT path: a
 * request flows through the gate, each property runs in the runner, and the
 * response carries the per-property `ActualResult` (PASS/FAIL on normal
 * completion). Counterexample / timeout / execution-error surfacing is task
 * 10.2 (the runner returns the full closed union, which passes through here
 * unchanged). Per-execution Execution_Context recording is task 10.3: the
 * orchestrator dispatches through the runner's context-aware channel
 * (`runPropertyWithContext`) and surfaces the recorded Execution_Context on
 * `PropertyExecutionResult.executionContexts` for EVERY execution (R6.1), with
 * the FAIL-Counterexample context as a fallback for a runner that does not
 * implement the channel (R6.2).
 */
import {
  type ActualResult,
  type CorrectnessProperty,
  type ExecutionContext,
  type PropertyExecutionRequest,
  type PropertyExecutionResult,
} from "@spec-lantern/types";
import {
  classifyPropertyExecution,
  isAccepted,
  type SafetyDecision,
} from "../safety-gate/index.js";
import {
  getIsolatedRunner,
  type IsolatedRunner,
} from "../runner/isolated-runner.js";

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Orchestration knobs. All optional so the production path is a zero-config
 * `executeProperties(request)`; tests inject a fake {@link IsolatedRunner} to
 * exercise the gate → dispatch → collect wiring without a real container.
 */
export interface ExecutePropertiesOptions {
  /**
   * The Isolated_Runner to dispatch accepted properties through. Defaults to
   * the MVP-scope local rootless Podman two-phase runner
   * ({@link getIsolatedRunner}). Overridable so tests can drive the
   * orchestration deterministically without Podman.
   */
  runner?: IsolatedRunner;
  /**
   * Per-run execution timeout in seconds forwarded to the runner for each
   * property. The runner defaults it when omitted (R5.7). Dedicated timeout
   * surfacing is task 10.2; here it is only plumbed to the runner.
   */
  timeoutSeconds?: number;
  /**
   * Optional sink for progress lines (defaults to no-op). Used by the MCP tool
   * handler to narrate dispatch over the transport's logging channel.
   */
  log?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Request → runner request mapping                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the single Correctness_Property test file for a property.
 *
 * The on-disk property-test-file convention (task 2.2) names each file
 * `property-{n}.{claimId}.test.ts`. A `PropertyExecutionRequest` carries the
 * `targetRepoRef` (the working directory the runner mounts) and the property's
 * `id` already follows the `property-{n}.{claimId}` stem, so the test file is
 * `<id>.test.ts` resolved inside the mounted target. The runner treats a
 * relative `propertyTestFile` as in-mount and runs it in place (see
 * {@link ../runner/test-phase.ts}), so this stays a path RELATIVE to the mount
 * and never a host path.
 *
 * NOTE: this convention mirrors the walking skeleton's layout. A future task
 * that threads an explicit artifact path through the request can override this,
 * but task 10.1's scope is the normal path where the property id IS the file
 * stem.
 */
function propertyTestFileFor(property: CorrectnessProperty): string {
  return `${property.id}.test.ts`;
}

/* -------------------------------------------------------------------------- */
/* The orchestrator                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Execute every Correctness_Property in a {@link PropertyExecutionRequest}
 * against the Target_Repo INSIDE the Isolated_Runner and collect the per-property
 * {@link ActualResult} into a {@link PropertyExecutionResult}.
 *
 * Flow:
 *  1. **Safety Gate first (R5.2, R12.1, R12.4).** The whole request is
 *     classified by {@link classifyPropertyExecution} BEFORE anything runs. If
 *     the gate rejects it (host-bound target/property), the rejection's
 *     per-property `SAFETY_VIOLATION` results are returned unchanged and NO
 *     runner is created — the host is untouched.
 *  2. **Dispatch accepted properties to the runner (R5.3).** Each property is
 *     run through the {@link IsolatedRunner} contract one at a time. The runner
 *     runs the install phase fully, then the no-network test phase, and resolves
 *     with a closed `ActualResult`. A runner that cannot be created surfaces
 *     `RUNNER_UNAVAILABLE` from within the runner — the orchestrator never falls
 *     back to the host (R5.8, R12.5).
 *  3. **Collect (R5.5).** The per-property results are gathered in request order.
 *     On normal completion each is a `VERDICT` (PASS/FAIL). The per-property
 *     Execution_Context is surfaced on the result's map so callers can read the
 *     context the run used; richer context recording is task 10.3.
 *
 * The function itself never spawns a process or touches the host filesystem; all
 * execution is delegated to the runner. Returning the closed union keeps PASS/
 * FAIL distinct from timeouts and errors (R5.5–R5.9), which task 10.2 surfaces
 * in full.
 *
 * @param request the properties to execute and the target the runner mounts
 * @param options optional runner override, timeout, and log sink
 * @returns the per-property results plus the Execution_Context each run used
 */
export async function executeProperties(
  request: PropertyExecutionRequest,
  options: ExecutePropertiesOptions = {},
): Promise<PropertyExecutionResult> {
  const log = options.log ?? (() => undefined);

  // 1. Safety Gate — classify the whole request BEFORE anything runs.
  const decision: SafetyDecision = classifyPropertyExecution(request);
  if (!isAccepted(decision)) {
    log(
      `Safety Gate REJECTED the request (${decision.violations
        .map((v) => v.code)
        .join(", ")}); returning SAFETY_VIOLATION without creating a runner`,
    );
    // Per-property SAFETY_VIOLATION results, host untouched. No runner created.
    return collect(decision.results);
  }

  log(
    `Safety Gate accepted the request (target=${decision.target}); ` +
      `dispatching ${request.properties.length} propert${
        request.properties.length === 1 ? "y" : "ies"
      } to the Isolated_Runner`,
  );

  // 2. Dispatch each accepted property through the runner. The runner owns the
  //    install→test ordering and the no-host-fallback guarantee.
  const runner = options.runner ?? getIsolatedRunner();
  const results: ActualResult[] = [];
  // Per-execution Execution_Context, recorded for EVERY execution (R6.1), keyed
  // by propertyId. The runner's context-aware channel reports it directly; a
  // runner that only implements `runProperty` contributes a context only when a
  // FAIL Counterexample carries one (see `collect`).
  const recordedContexts: Record<string, ExecutionContext> = {};
  for (const property of request.properties) {
    log(`Executing property ${property.id} in the runner…`);
    const runnerRequest = {
      propertyId: property.id,
      targetRepoPath: request.targetRepoRef,
      propertyTestFile: propertyTestFileFor(property),
      timeoutSeconds: options.timeoutSeconds,
    };

    // Prefer the context-aware channel (task 10.3): it surfaces the
    // Execution_Context the run used for EVERY outcome — PASS, FAIL, TIMEOUT, or
    // ERROR — not only when a FAIL Counterexample happens to bundle one (R6.1).
    // Fall back to plain `runProperty` for a runner that does not implement it.
    let result: ActualResult;
    if (runner.runPropertyWithContext) {
      const withContext = await runner.runPropertyWithContext(runnerRequest);
      result = withContext.result;
      recordedContexts[property.id] = withContext.executionContext;
    } else {
      result = await runner.runProperty(runnerRequest);
    }
    log(`Property ${property.id} → ${result.outcome}`);
    results.push(result);
  }

  // 3. Collect into the response shape, surfacing a per-property context for
  //    every execution the runner reported one for.
  return collect(results, recordedContexts);
}

/**
 * Assemble a {@link PropertyExecutionResult} from a list of per-property
 * {@link ActualResult}s and the per-execution Execution_Contexts the runner
 * recorded (task 10.3).
 *
 * The response carries the results in request order plus a map of
 * propertyId → Execution_Context. The map is populated for EVERY execution the
 * runner reported a context for (R6.1), via the runner's context-aware channel.
 * As a fallback for a runner that reports no context directly, a FAIL
 * `VERDICT` whose Counterexample bundles the exact context its run used still
 * contributes that context (R6.2) — the recorded context, when present, takes
 * precedence, and the two always agree because the runner hands the SAME
 * context object to both channels. An execution for which neither a recorded
 * context nor a Counterexample context exists simply has no map entry, keeping
 * the response honest.
 */
function collect(
  results: ActualResult[],
  recordedContexts: Record<string, ExecutionContext> = {},
): PropertyExecutionResult {
  const executionContexts: Record<string, ExecutionContext> = {};
  for (const result of results) {
    // Prefer the per-execution context the runner recorded for this property
    // (surfaced for every outcome, R6.1).
    const recorded = recordedContexts[result.propertyId];
    if (recorded) {
      executionContexts[result.propertyId] = recorded;
      continue;
    }
    // Fallback: a FAIL Counterexample bundles the context its run used (R6.2).
    if (result.outcome === "VERDICT" && result.counterexample) {
      executionContexts[result.propertyId] =
        result.counterexample.executionContext;
    }
  }
  return { results, executionContexts };
}
