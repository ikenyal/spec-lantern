/**
 * Counterexample replay from a recorded Execution_Context (task 11.1).
 *
 * This module implements the `replay_counterexample` path (design "Component 2:
 * MCP_Server", tool table: `replay_counterexample | { property, executionContext }
 * | Actual_Result (must equal the original)`). Its single job is the
 * reproducibility guarantee R6.3:
 *
 *   WHEN a Counterexample is replayed using the Execution_Context recorded with
 *   that Counterexample, THE MCP_Server SHALL produce the same Actual_Result
 *   that was recorded for the original execution.
 *
 * HOW REPLAY REPRODUCES THE ORIGINAL. The original execution's determinism is
 * already established by task 10.3: every run FIXES its Random_Seed, pins its
 * timezone and Fixed_Current_Time, and records all three as an
 * {@link ExecutionContext} that is threaded INTO the no-network test container
 * — fast-check is seeded from the recorded Random_Seed and `TZ`/the fixed
 * instant are pinned (see {@link ../runner/execution-context.ts}). Replay does
 * NOT re-derive any of that; it simply FORCES the SAME recorded context back
 * through the SAME runner path:
 *
 *     original run:  record a fresh context → thread it in → ActualResult
 *     replay:        reuse the recorded context → thread it in → ActualResult'
 *
 * Because the runner's context-recorder ({@link recordExecutionContext}) uses a
 * caller-supplied context VERBATIM (it only chooses a new one when none is
 * pinned), handing the recorded context to the runner makes the replay seed,
 * timezone, and fixed instant byte-identical to the original — so a
 * deterministic property regenerates the identical input sequence and yields the
 * same `ActualResult` (R6.3).
 *
 * NO DUPLICATED EXECUTION LOGIC. Replay deliberately routes through the exact
 * same seam as {@link executeProperties}: the Safety Gate first, then the
 * {@link IsolatedRunner} contract. It is a thin wrapper that (a) builds a
 * single-property {@link PropertyExecutionRequest} so the Safety Gate classifies
 * the target identically (host-bound replays are still rejected as
 * `SAFETY_VIOLATION` before anything runs), and (b) forces the recorded
 * Execution_Context onto the runner request so the run is pinned rather than
 * freshly recorded. All host-safety invariants therefore hold unchanged: no host
 * execution, no host fallback (`RUNNER_UNAVAILABLE` surfaces verbatim), and only
 * a THROWAWAY working copy of the target is mounted — never the original. Replay
 * copies `targetRepoRef` into a fresh `/Users`-visible copy (the same way
 * {@link executeProperties} does) and removes it afterwards, so the original
 * Target_Repo stays byte-for-byte unchanged (the install phase writes
 * `node_modules`/lock files into the mount).
 *
 * SCOPE (task 11.1). This module wires the replay PATH and forces the recorded
 * context through the runner. The optional Property 12 reproducibility
 * property-test is task 11.2 and is not implemented here.
 */
import {
  type ActualResult,
  type CorrectnessProperty,
  type ExecutionContext,
  type PropertyExecutionRequest,
} from "@spec-lantern/types";
import {
  classifyPropertyExecution,
  isAccepted,
  type SafetyDecision,
} from "../safety-gate/index.js";
import {
  getIsolatedRunner,
  type IsolatedRunner,
  type IsolatedRunnerRequest,
} from "../runner/isolated-runner.js";
import {
  prepareWorkingCopy,
  cleanupWorkingCopy,
  stagedPropertyTestFileRel,
} from "../runner/working-copy.js";

/* -------------------------------------------------------------------------- */
/* Request / options                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The input to {@link replayCounterexample} — the serializable shape the
 * `replay_counterexample` MCP tool carries (design tool table:
 * `{ property, executionContext }`).
 *
 * `targetRepoRef` is the ONE directory the runner mounts; it is classified by
 * the Safety Gate exactly as an {@link PropertyExecutionRequest} target is, so a
 * host-bound replay is rejected before any code runs.
 */
export interface ReplayCounterexampleRequest {
  /**
   * Path / copy reference the runner mounts (never executed on the host). The
   * same working directory the ORIGINAL execution ran against must be supplied
   * so replay reproduces the original result.
   */
  targetRepoRef: string;
  /** The single Correctness_Property to replay. */
  property: CorrectnessProperty;
  /**
   * The Execution_Context recorded WITH the original Counterexample (R6.2). Its
   * Random_Seed, timezone, and Fixed_Current_Time are forced back through the
   * runner so the replay is pinned to the exact conditions the original ran
   * under (R6.3) — the runner uses this verbatim rather than recording a fresh
   * one.
   */
  executionContext: ExecutionContext;
}

/**
 * Orchestration knobs for {@link replayCounterexample}. All optional so the
 * production path is a zero-config `replayCounterexample(request)`; tests inject
 * a fake {@link IsolatedRunner} to exercise the gate → forced-context dispatch
 * wiring without a real container.
 */
export interface ReplayCounterexampleOptions {
  /**
   * The Isolated_Runner to replay through. Defaults to the MVP-scope local
   * rootless Podman two-phase runner ({@link getIsolatedRunner}). Overridable so
   * tests drive replay deterministically without Podman.
   */
  runner?: IsolatedRunner;
  /**
   * Optional spec root. When provided, the replay stages the property's
   * `properties/property-{n}.{claimId}.test.ts` from the spec root INTO the
   * throwaway working copy itself so the caller need not place it by hand. When
   * omitted, the property is assumed to already live inside the copy and the
   * runner resolves `<id>.test.ts` in place.
   */
  specRoot?: string;
  /**
   * Override the throwaway working-copy directory (tests). Normally a fresh,
   * unique `/Users`-visible dir is created per call and removed afterwards.
   */
  workingCopyDir?: string;
  /**
   * Skip copying the Target_Repo into a throwaway working copy and mount
   * `targetRepoRef` directly. DANGEROUS for a real target (the install phase
   * writes into the mount); it exists only for unit tests that drive the wiring
   * with a fake runner and a symbolic target ref. Defaults to `false`: a real
   * replay always copies.
   */
  mountInPlace?: boolean;
  /**
   * Per-run execution timeout in seconds forwarded to the runner. The runner
   * defaults it when omitted (R5.7).
   */
  timeoutSeconds?: number;
  /** Optional sink for progress lines (defaults to no-op). */
  log?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Request → runner request mapping                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the single Correctness_Property test file for a property. Mirrors the
 * orchestrator's convention (the property id IS the on-disk file stem, so the
 * test file is `<id>.test.ts` resolved inside the mounted target) so a property
 * replays from the identical file it originally executed from.
 */
function propertyTestFileFor(property: CorrectnessProperty): string {
  return `${property.id}.test.ts`;
}

/* -------------------------------------------------------------------------- */
/* The replay path                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Replay ONE Correctness_Property under a recorded {@link ExecutionContext} and
 * resolve with the {@link ActualResult} the replay produced — which, for a
 * deterministic property, equals the originally recorded result (R6.3).
 *
 * Flow (identical safety discipline to {@link executeProperties}):
 *  1. **Safety Gate first (R5.2, R12.1, R12.4).** The replay is wrapped in a
 *     single-property {@link PropertyExecutionRequest} and classified BEFORE
 *     anything runs. A host-bound target is rejected and its per-property
 *     `SAFETY_VIOLATION` `ActualResult` is returned unchanged — NO runner is
 *     created and the host is untouched.
 *  2. **Dispatch through the runner with the recorded context FORCED (R6.3).**
 *     The accepted property is run through the {@link IsolatedRunner} contract
 *     with `executionContext` set to the recorded context. The runner threads
 *     that exact context in (seeds fast-check from its Random_Seed, pins its
 *     timezone + Fixed_Current_Time) rather than recording a fresh one, so the
 *     run reproduces the original conditions.
 *  3. **Return the single {@link ActualResult}.** Replay surfaces exactly the
 *     one result (the tool's output is `Actual_Result`, not a batch), keeping
 *     the closed-union discipline: PASS/FAIL on normal completion, or the
 *     distinct TIMEOUT / EXECUTION_ERROR / RUNNER_UNAVAILABLE / SAFETY_VIOLATION
 *     outcomes.
 *
 * The function itself never spawns a process or touches the host filesystem; all
 * execution is delegated to the runner, and there is no code path to host
 * fallback (`RUNNER_UNAVAILABLE` surfaces verbatim, R5.8, R12.5).
 *
 * @param request the property to replay, the target the runner mounts, and the
 *   recorded Execution_Context to force
 * @param options optional runner override, timeout, and log sink
 * @returns the single {@link ActualResult} the replay produced
 */
export async function replayCounterexample(
  request: ReplayCounterexampleRequest,
  options: ReplayCounterexampleOptions = {},
): Promise<ActualResult> {
  const log = options.log ?? (() => undefined);

  // 1. Safety Gate — classify the replay (as a single-property request) BEFORE
  //    anything runs. This reuses the SAME classification `executeProperties`
  //    uses, so a host-bound replay is rejected identically.
  const gateRequest: PropertyExecutionRequest = {
    targetRepoRef: request.targetRepoRef,
    properties: [request.property],
    phase: "initial",
  };
  const decision: SafetyDecision = classifyPropertyExecution(gateRequest);
  if (!isAccepted(decision)) {
    log(
      `Safety Gate REJECTED the replay (${decision.violations
        .map((v) => v.code)
        .join(", ")}); returning SAFETY_VIOLATION without creating a runner`,
    );
    // The gate produces one per-property SAFETY_VIOLATION; replay surfaces the
    // single result for its one property. Falling back to a synthesized
    // SAFETY_VIOLATION keeps the return type total even if the gate's result
    // list were ever empty.
    return (
      decision.results[0] ?? {
        propertyId: request.property.id,
        outcome: "SAFETY_VIOLATION",
        reason: "replay target rejected by the Safety Gate",
      }
    );
  }

  log(
    `Safety Gate accepted the replay (target=${decision.target}); replaying ` +
      `property ${request.property.id} under the recorded Execution_Context ` +
      `(seed=${request.executionContext.randomSeed}, ` +
      `tz=${request.executionContext.timezone}, ` +
      `now=${request.executionContext.fixedCurrentTime})`,
  );

  // 2. Copy the Target_Repo into a FRESH throwaway working copy and replay
  //    against THAT — never the original (the install phase writes node_modules/
  //    lock files into whatever is mounted; the original must stay read-only,
  //    exactly as execute_properties does). Optionally stage the property file
  //    from a spec root into the copy. `mountInPlace` is a test-only escape hatch.
  const mountInPlace = options.mountInPlace ?? false;
  let mountPath = request.targetRepoRef;
  let staged = false;
  let workingCopyDir: string | undefined;
  if (!mountInPlace) {
    const prepared = await prepareWorkingCopy(request.targetRepoRef, {
      specRoot: options.specRoot,
      properties: options.specRoot ? [request.property] : undefined,
      workingCopyDir: options.workingCopyDir,
      log,
    });
    workingCopyDir = prepared.workingCopyDir;
    mountPath = prepared.workingCopyDir;
    staged = options.specRoot !== undefined;
  }

  try {
    // 3. Dispatch through the runner with the recorded context FORCED. The runner
    //    uses a supplied context verbatim (see recordExecutionContext), so the
    //    replay seed/timezone/fixed-instant match the original exactly (R6.3).
    const runner = options.runner ?? getIsolatedRunner();
    const runnerRequest: IsolatedRunnerRequest = {
      propertyId: request.property.id,
      targetRepoPath: mountPath,
      propertyTestFile: staged
        ? stagedPropertyTestFileRel(request.property.id)
        : propertyTestFileFor(request.property),
      executionContext: request.executionContext,
      timeoutSeconds: options.timeoutSeconds,
    };

    const result = await runner.runProperty(runnerRequest);
    log(`Replay of property ${request.property.id} → ${result.outcome}`);

    // 4. Return the single ActualResult (the tool's output is one result).
    return result;
  } finally {
    // 5. Remove the throwaway copy; the original was never mounted.
    if (workingCopyDir) {
      await cleanupWorkingCopy(workingCopyDir).catch(() => undefined);
    }
  }
}
