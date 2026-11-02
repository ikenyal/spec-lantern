/**
 * The Isolated_Runner contract (task 8.2).
 *
 * This module GENERALIZES the concrete two-phase runner
 * ({@link ./test-phase.ts}) into an explicit, reusable INTERFACE so the rest of
 * the MCP_Server programs against the *contract* rather than a single concrete
 * function. The Safety Gate (task 8.1), the two-phase network topology
 * (task 9), and the execution orchestrator / `execute_properties` tool
 * (task 10) all dispatch through an {@link IsolatedRunner}; swapping the
 * concrete implementation (local rootless Podman today; the AWS Fargate runner
 * is Future Work) must not ripple into those callers.
 *
 * The interface codifies the two overriding host-safety invariants that make
 * the Isolated_Runner the product's safety boundary (design "Safety Architecture"):
 *
 *  1. Boundary confinement (R12.6). The runner mounts ONLY the one target
 *     working directory it was handed and confines every Target_Repo file read
 *     and write to that boundary. It never mounts `$HOME`, `/tmp`, or any other
 *     broad path, and it never reads or writes outside the single mount.
 *
 *  2. No host fallback (R5.8, R12.5). The runner is the SINGLE execution target
 *     for Target_Repo code. There is no code path from "the runner could not be
 *     created / is unavailable" to "run the target on the host". When the runner
 *     cannot be created or is unavailable, the implementation aborts and surfaces
 *     a `RUNNER_UNAVAILABLE` {@link ActualResult} that *identifies the reason*;
 *     it NEVER degrades to host execution and NEVER invents a different result
 *     shape to paper over the failure.
 *
 * The contract is expressed purely over the closed `ActualResult` union from
 * `@spec-lantern/types` — the same union the concrete runner already returns.
 * Implementations MUST NOT widen it with bespoke success/error shapes; the
 * `RUNNER_UNAVAILABLE` member (`{ propertyId; outcome: "RUNNER_UNAVAILABLE";
 * reason }`) is the one and only way an implementation reports that it could not
 * stand up the isolation boundary.
 */
import type { ActualResult, ExecutionContext } from "@spec-lantern/types";
import {
  runTwoPhase,
  runTwoPhaseWithContext,
  type ExecutionWithContext,
  type TestPhaseRequest,
} from "./test-phase.js";

/**
 * A request to run exactly one Correctness_Property inside the Isolated_Runner.
 *
 * This is the generalized, implementation-agnostic shape callers build. It is
 * intentionally identical to the concrete {@link TestPhaseRequest} so the local
 * two-phase Podman runner satisfies it without adaptation; the alias keeps a
 * single source of truth for the field documentation (see test-phase.ts) while
 * giving callers a name that does not bind them to Podman.
 *
 * The two fields that carry the boundary-confinement invariant (R12.6):
 *  - `targetRepoPath` is the ONE directory the runner mounts. The implementation
 *    mounts this and nothing else, and confines all Target_Repo file access to
 *    it.
 *  - `propertyTestFile` is resolved to a path inside that mount (run in place
 *    when already under `targetRepoPath`, otherwise staged into the mount) so it
 *    is reachable only from within the boundary and never executes on the host.
 */
export type IsolatedRunnerRequest = TestPhaseRequest;

/**
 * The Isolated_Runner contract — the single execution target for Target_Repo
 * code.
 *
 * An implementation runs exactly one Correctness_Property test file against the
 * Target_Repo (or Target_Repo_Copy) INSIDE an isolation boundary and resolves
 * with a closed {@link ActualResult}. The MVP-scope implementation is the local
 * rootless Podman two-phase runner ({@link podmanIsolatedRunner}); an AWS
 * Fargate implementation is Future Work and would implement this same interface.
 *
 * Invariants every implementation MUST honor:
 *  - **Container-not-host execution (R5.2).** Install, build, and test of the
 *    target run only inside the isolation boundary. No code path runs the
 *    target's install/build/test in the host process or host shell.
 *  - **Boundary confinement (R12.6).** Only `request.targetRepoPath` is mounted;
 *    Target_Repo file reads and writes are confined to that mount.
 *  - **No host fallback (R5.8, R12.5).** If the runner cannot be created or is
 *    unavailable, resolve with a `RUNNER_UNAVAILABLE` outcome whose `reason`
 *    identifies the failure, and NEVER fall back to executing the target on the
 *    host.
 *  - **Closed outcomes.** The resolved value is always one of the
 *    `ActualResult` shapes. Timeouts and execution errors are their own
 *    outcomes, never encoded as PASS/FAIL.
 *
 * The method NEVER rejects for a runner/boundary failure — such a failure is
 * reported in-band as `RUNNER_UNAVAILABLE` (or `EXECUTION_ERROR` for an
 * in-boundary orchestration fault) so a caller can never mistake "the boundary
 * failed" for "the property passed/failed".
 */
export interface IsolatedRunner {
  /**
   * Run one Correctness_Property inside the isolation boundary and resolve with
   * its {@link ActualResult}.
   *
   * @param request The property, the single working directory to mount, and the
   *   per-run execution context/limits.
   * @returns The closed `ActualResult`. On a runner-create failure or an
   *   unavailable runner this is a `RUNNER_UNAVAILABLE` outcome identifying the
   *   reason — never a host-executed verdict.
   */
  runProperty(request: IsolatedRunnerRequest): Promise<ActualResult>;

  /**
   * OPTIONAL context-aware variant (task 10.3). Run one Correctness_Property
   * and resolve with its {@link ActualResult} TOGETHER WITH the
   * {@link ExecutionContext} recorded for the run.
   *
   * This is the channel by which the per-execution Execution_Context reaches
   * the orchestrator for EVERY execution (R6.1) — not only when a FAIL
   * Counterexample happens to carry one. An implementation that records an
   * Execution_Context (the MVP-scope Podman runner does) SHOULD implement this;
   * the orchestrator prefers it when present and otherwise falls back to reading
   * the context off a FAIL Counterexample via {@link runProperty}. The resolved
   * `result` obeys the identical closed-union + no-host-fallback contract as
   * {@link runProperty}.
   */
  runPropertyWithContext?(
    request: IsolatedRunnerRequest,
  ): Promise<{ result: ActualResult; executionContext: ExecutionContext }>;
}

/**
 * The MVP-scope {@link IsolatedRunner}: the local rootless Podman TWO-PHASE
 * runner.
 *
 * This is the thin adapter that makes the concrete task-9 two-phase runner
 * ({@link runTwoPhase}) conform to the generalized contract. It adds no behavior
 * of its own — `runProperty` IS `runTwoPhase` — so every host-safety invariant
 * the two-phase runner proves is exactly the behavior exposed through the
 * interface: dependencies install behind the internal-only network + Verdaccio
 * proxy (`--ignore-scripts`, registry only), the property then executes with
 * `--network none` (no inbound/outbound access at all), Podman-unavailability
 * surfaces as `RUNNER_UNAVAILABLE` with no host fallback, and ONLY the target
 * working directory is mounted (plain macOS-safe bind mount). Callers (Safety
 * Gate, orchestrator) depend on {@link IsolatedRunner}, not on this concrete
 * object, so the Podman implementation can later sit beside an AWS Fargate one
 * without changing them.
 */
export const podmanIsolatedRunner: IsolatedRunner = {
  runProperty(request: IsolatedRunnerRequest): Promise<ActualResult> {
    return runTwoPhase(request);
  },
  runPropertyWithContext(
    request: IsolatedRunnerRequest,
  ): Promise<ExecutionWithContext> {
    // Delegates to the context-aware two-phase core so the Execution_Context
    // recorded for the run (R6.1) is surfaced alongside the ActualResult.
    return runTwoPhaseWithContext(request);
  },
};

/**
 * Convenience accessor for the single MVP-scope Isolated_Runner implementation.
 *
 * Centralizing the choice here means a future Fargate runner is a one-line swap
 * at this seam, and every caller that asks for "the" runner goes through the
 * same contract.
 */
export function getIsolatedRunner(): IsolatedRunner {
  return podmanIsolatedRunner;
}
