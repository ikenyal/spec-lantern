/**
 * The Revive loop — re-execute-after-fix and Property_Transition (task 15.2,
 * design Component 2 "Revive", tool `apply_fixes_and_reexecute`).
 *
 * This module realizes the SECOND half of the Revive loop. Task 15.1
 * ({@link ./apply-fixes.ts}) made a COPY of the Target_Repo and wrote each
 * Kiro-authored Fix_Task's edits into that copy, leaving the original
 * byte-for-byte unchanged. This module picks up from "the fixed copy exists"
 * and:
 *
 *     Pre_Fix_Result (per property)            ← caller already has this
 *       │  (the initial execution against the ORIGINAL, from `execute_properties`)
 *       │
 *       ▼
 *   applyFixesToCopy (15.1)  ──▶  Target_Repo_Copy with fixes applied
 *       │
 *       ▼
 *   executeProperties(targetRepoRef = COPY, phase = "post_fix")   ← R8.3
 *       │
 *       ▼
 *   Post_Fix_Result (per property)
 *       │
 *       ▼
 *   pair Pre↔Post → Property_Transition   ← R8.5, R8.6, R8.7
 *
 * WHY WE REUSE `executeProperties` RATHER THAN THE RUNNER DIRECTLY. The whole
 * host-safety discipline (Safety Gate → Isolated_Runner, two-phase network
 * topology, no host fallback, closed `ActualResult` union) already lives behind
 * {@link executeProperties}. Re-executing after a fix is the SAME execution,
 * only against the copy and tagged `phase: "post_fix"`. Threading the copy path
 * as the request's `targetRepoRef` means the Safety Gate classifies the copy
 * exactly as it would any target (a host-bound copy ref is still rejected), the
 * install+test phases run in the container against the FIXED code, and nothing
 * new has to duplicate the runner wiring. The runner override flows straight
 * through `ExecutePropertiesOptions`, so tests inject a fake runner here too.
 *
 * WHY THE PRE_FIX RESULTS ARE AN INPUT, NOT RE-COMPUTED HERE. R8.4 asks us to
 * record BOTH the Pre_Fix_Result and the Post_Fix_Result. The Pre_Fix_Result is
 * the ORIGINAL execution outcome the caller already obtained from
 * `execute_properties` against the ORIGINAL Target_Repo (the Comparison Engine,
 * task 14, consumed those same results). Re-running the original here would both
 * waste a container run and risk a DIFFERENT outcome than the one comparison
 * already classified. So the Pre_Fix_Result is passed IN (as the initial
 * `ActualResult` per property), and this module only runs the POST-fix side —
 * the fixed copy — then pairs the two. This keeps "pre" and "post" honest: pre
 * is the exact result the pipeline already recorded, post is a fresh run against
 * the fixed copy.
 *
 * HOW A TRANSITION IS CLASSIFIED (R8.5–R8.7). A Property_Transition is only
 * meaningful between two PASS/FAIL VERDICTS. {@link classifyTransition} maps the
 * (pre, post) verdict pair EXACTLY:
 *   - FAIL → PASS = FIXED
 *   - FAIL → FAIL = NOT_RESOLVED   (R8.6)
 *   - PASS → FAIL = REGRESSION     (R8.7)
 *   - PASS → PASS = STILL_PASSING
 * A property whose pre- OR post-fix result is a NON-VERDICT outcome (TIMEOUT,
 * EXECUTION_ERROR, RUNNER_UNAVAILABLE, SAFETY_VIOLATION) does NOT get a
 * fabricated transition — there is no PASS/FAIL pair to compare, and encoding a
 * timeout/error as a transition would be a lie. Such properties are reported in
 * `skippedPropertyIds` with no transition, mirroring how the Comparison Engine
 * (R7.4) refuses to compare a timeout. The `PropertyTransition.preFixResult` /
 * `postFixResult` fields are typed as `Verdict`, which is itself the compiler's
 * reminder that only VERDICTs produce a transition.
 *
 * HOST-SAFETY. This module spawns no process and runs no Target_Repo code
 * itself. The copy+apply is plain filesystem work (15.1); the re-execution is
 * delegated to {@link executeProperties}, which routes through the Safety Gate
 * and the Isolated_Runner. There is no host-execution or host-fallback path
 * introduced here.
 */
import {
  type ActualResult,
  type CorrectnessProperty,
  type PropertyExecutionRequest,
  type PropertyExecutionResult,
  type PropertyTransition,
  type Verdict,
} from "@spec-lantern/types";
import {
  applyFixesToCopy,
  cleanupTargetRepoCopy,
  type ApplyFixesOptions,
  type FixApplication,
} from "./apply-fixes.js";
import {
  executeProperties,
  type ExecutePropertiesOptions,
} from "../orchestrator/index.js";
import { stagePropertiesInto } from "../runner/working-copy.js";

/* -------------------------------------------------------------------------- */
/* Pure transition classification                                             */
/* -------------------------------------------------------------------------- */

/**
 * Classify a single property's Pre_Fix → Post_Fix transition from the two
 * recorded VERDICTs (R8.5–R8.7).
 *
 * This is the whole decision table, and nothing else is a valid transition:
 *   - `FAIL` → `PASS`  ⇒ `FIXED`        (the fix resolved the Confirmed_Bug)
 *   - `FAIL` → `FAIL`  ⇒ `NOT_RESOLVED` (R8.6 — the fix did NOT resolve it)
 *   - `PASS` → `FAIL`  ⇒ `REGRESSION`   (R8.7 — the fix broke a passing property)
 *   - `PASS` → `PASS`  ⇒ `STILL_PASSING`
 *
 * It is a PURE function over two `Verdict`s — deliberately NOT over the whole
 * `ActualResult` union — because a transition is only defined between PASS/FAIL
 * verdicts. A caller holding a non-VERDICT outcome (TIMEOUT / EXECUTION_ERROR /
 * etc.) must NOT call this with a fabricated verdict; it should skip the
 * property instead (see {@link verdictOf} and the orchestrator's skip path). The
 * four-way `switch` is exhaustive over the two-verdict product, so every input
 * yields exactly one classification.
 *
 * @param preFixResult the verdict BEFORE the fix (against the original repo).
 * @param postFixResult the verdict AFTER the fix (against the fixed copy).
 * @param propertyId the property both verdicts belong to.
 * @returns the fully-populated {@link PropertyTransition}.
 */
export function classifyTransition(
  preFixResult: Verdict,
  postFixResult: Verdict,
  propertyId: string,
): PropertyTransition {
  let classification: PropertyTransition["classification"];
  if (preFixResult === "FAIL" && postFixResult === "PASS") {
    classification = "FIXED";
  } else if (preFixResult === "FAIL" && postFixResult === "FAIL") {
    classification = "NOT_RESOLVED";
  } else if (preFixResult === "PASS" && postFixResult === "FAIL") {
    classification = "REGRESSION";
  } else {
    // The only remaining pair is PASS → PASS.
    classification = "STILL_PASSING";
  }
  return { propertyId, preFixResult, postFixResult, classification };
}

/**
 * Extract the PASS/FAIL {@link Verdict} from an {@link ActualResult}, or `null`
 * when the result is a NON-VERDICT outcome (TIMEOUT, EXECUTION_ERROR,
 * RUNNER_UNAVAILABLE, SAFETY_VIOLATION).
 *
 * This is the single gate that keeps {@link classifyTransition} honest: a
 * transition is built ONLY when BOTH the pre- and post-fix results yield a
 * verdict here. A `null` on either side means "no comparable pair", and the
 * property is skipped rather than assigned a fabricated transition.
 */
function verdictOf(result: ActualResult | undefined): Verdict | null {
  if (result && result.outcome === "VERDICT") {
    return result.verdict;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Request / options / result                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The input to {@link applyFixesAndReexecute} — the serializable shape the
 * `apply_fixes_and_reexecute` MCP tool carries.
 *
 * The design tool table names the input `{ targetRepoCopyRef, fixTasks[],
 * properties[] }`. In this codebase a Fix_Task's `description` is natural
 * language, so the concrete, deterministic realization of a fix is a
 * {@link FixApplication} (a Fix_Task paired with its {@link FileEdit}s), exactly
 * as task 15.1 defined. We therefore carry `applications` (the realizable fixes)
 * rather than bare `fixTasks`, and the original repo path (`targetRepoRef`) that
 * 15.1 COPIES from — the "targetRepoCopyRef" in the design is produced HERE by
 * `applyFixesToCopy`, not supplied, so this module owns making the copy.
 *
 * `preFixResults` are the Pre_Fix_Results (R8.4): the ORIGINAL execution
 * outcomes the caller already obtained from `execute_properties` against the
 * original repo, keyed by propertyId. They are passed in rather than recomputed
 * so "pre" is exactly the result the pipeline already recorded.
 */
export interface ApplyFixesAndReexecuteRequest {
  /**
   * Path to the ORIGINAL Target_Repo (read-only). This module COPIES it via
   * task 15.1 and re-executes against the copy; the original is never written
   * to or executed.
   */
  targetRepoRef: string;
  /** The Fix_Tasks + their concrete edits to realize on the copy (15.1). */
  applications: FixApplication[];
  /** The SAME Correctness_Properties to re-execute against the fixed copy. */
  properties: CorrectnessProperty[];
  /**
   * The Pre_Fix_Result per propertyId (R8.4) — the initial execution outcome
   * against the ORIGINAL repo the caller already has. A property with no entry
   * here (or a non-VERDICT entry) gets no transition.
   */
  preFixResults: Record<string, ActualResult>;
}

/**
 * Orchestration knobs for {@link applyFixesAndReexecute}.
 *
 * `execute` forwards straight to {@link executeProperties} so a test injects a
 * FAKE Isolated_Runner for the POST-fix run (no Podman needed). `apply` forwards
 * to {@link applyFixesToCopy} (copy-location override + log). `keepCopy` leaves
 * the Target_Repo_Copy on disk after re-execution (defaults to cleaning it up)
 * for callers/tests that want to inspect it.
 */
export interface ApplyFixesAndReexecuteOptions {
  /** Overrides forwarded to {@link executeProperties} for the post-fix run. */
  execute?: ExecutePropertiesOptions;
  /** Overrides forwarded to {@link applyFixesToCopy} (copy dir + log). */
  apply?: ApplyFixesOptions;
  /**
   * OPTIONAL spec root holding `properties/property-{n}.{claimId}.test.ts`. When
   * provided, the property test files are staged from here INTO the fixed copy
   * before re-execution, so the caller need not place them by hand (the copy is
   * mounted in place, so the files must already be inside it).
   */
  specRoot?: string;
  /**
   * Keep the Target_Repo_Copy on disk after re-execution. Defaults to `false`
   * (the copy is a throwaway artifact of this call and is removed). Set `true`
   * when a caller wants to inspect or reuse the fixed copy.
   */
  keepCopy?: boolean;
  /** Optional sink for progress lines (defaults to no-op). */
  log?: (message: string) => void;
}

/**
 * The per-property pairing of Pre_Fix_Result and Post_Fix_Result plus the
 * derived transition (R8.4, R8.5).
 *
 * `transition` is present ONLY when BOTH results are PASS/FAIL verdicts; it is
 * `undefined` for a property whose pre- or post-fix result was a non-VERDICT
 * outcome (that property's id also appears in {@link ApplyFixesAndReexecuteResult.skippedPropertyIds}).
 */
export interface PropertyFixOutcome {
  propertyId: string;
  /** The Pre_Fix_Result recorded before the fix (R8.4). */
  preFixResult: ActualResult | undefined;
  /** The Post_Fix_Result recorded after re-executing against the copy (R8.4). */
  postFixResult: ActualResult | undefined;
  /** The transition, present only when both sides are PASS/FAIL (R8.5). */
  transition?: PropertyTransition;
}

/**
 * The output of {@link applyFixesAndReexecute} — the design's "Property_Execution_Result
 * with Pre/Post results".
 *
 * It carries:
 *  - `postFixExecution`: the raw {@link PropertyExecutionResult} from re-executing
 *    the properties against the fixed copy (R8.3) — the Post_Fix side, including
 *    per-property Execution_Contexts.
 *  - `outcomes`: the per-property Pre/Post pairing + transition (R8.4, R8.5).
 *  - `transitions`: just the derived {@link PropertyTransition}s (a flat list for
 *    the report, R8.5–R8.7).
 *  - `skippedPropertyIds`: properties for which NO transition could be built
 *    because a side was a non-VERDICT outcome (honest "not comparable").
 *  - `targetRepoCopyPath`: the copy that was re-executed (populated whether or
 *    not it was kept, so a caller can correlate; it only still EXISTS on disk
 *    when `keepCopy` was set).
 *  - `appliedFixTaskIds`: the Fix_Tasks applied, in order, for traceability.
 *
 * Everything is plain serializable JSON so it crosses the MCP boundary as the
 * tool's structured output.
 */
export interface ApplyFixesAndReexecuteResult {
  /** The Post_Fix execution result against the fixed copy (R8.3). */
  postFixExecution: PropertyExecutionResult;
  /** Per-property Pre/Post pairing + transition (R8.4, R8.5). */
  outcomes: PropertyFixOutcome[];
  /** The derived transitions (flat list for the report, R8.5–R8.7). */
  transitions: PropertyTransition[];
  /** Properties with no comparable PASS/FAIL pair (no transition built). */
  skippedPropertyIds: string[];
  /** The Target_Repo_Copy that was re-executed. */
  targetRepoCopyPath: string;
  /** The Fix_Tasks applied to the copy, in application order. */
  appliedFixTaskIds: string[];
}

/* -------------------------------------------------------------------------- */
/* The orchestrator                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Apply Kiro-authored fixes to a fresh Target_Repo_Copy, re-execute the SAME
 * Correctness_Properties against that copy inside the Isolated_Runner, and
 * record each property's Pre_Fix_Result / Post_Fix_Result plus its
 * {@link PropertyTransition} (task 15.2, R8.3–R8.7).
 *
 * Flow:
 *  1. **Apply fixes to a COPY (R8.3 setup, reusing 15.1).** {@link applyFixesToCopy}
 *     copies the original (read-only) and writes every {@link FixApplication}'s
 *     edits into the copy. The original stays byte-for-byte unchanged; this
 *     module never writes to or executes it.
 *  2. **Re-execute against the copy (R8.3, R8.4 post side).** Build a
 *     {@link PropertyExecutionRequest} whose `targetRepoRef` is the COPY path and
 *     whose `phase` is `"post_fix"`, and delegate to {@link executeProperties}.
 *     That routes through the Safety Gate and the two-phase runner exactly as
 *     the initial execution did — the same properties, now against the fixed
 *     code. The runner override flows through via `options.execute` so tests use
 *     a fake runner.
 *  3. **Pair Pre↔Post and classify (R8.4, R8.5–R8.7).** For each property, take
 *     the caller-supplied Pre_Fix_Result and the just-produced Post_Fix_Result.
 *     When BOTH are PASS/FAIL verdicts, build a {@link PropertyTransition} via
 *     {@link classifyTransition}; otherwise record no transition and add the id
 *     to `skippedPropertyIds`.
 *  4. **Clean up the copy** unless `keepCopy` is set (it is a throwaway artifact
 *     of this call).
 *
 * @param request the original repo path, the fixes to apply, the properties to
 *   re-run, and the Pre_Fix_Results already recorded.
 * @param options runner/apply overrides, copy retention, and a log sink.
 * @returns the Post_Fix execution plus the per-property Pre/Post pairing and
 *   transitions.
 */
export async function applyFixesAndReexecute(
  request: ApplyFixesAndReexecuteRequest,
  options: ApplyFixesAndReexecuteOptions = {},
): Promise<ApplyFixesAndReexecuteResult> {
  const log = options.log ?? (() => undefined);

  // 1. Apply fixes to a fresh copy (15.1). The original is read-only.
  log(
    `Applying ${request.applications.length} fix application(s) to a copy of ` +
      `${request.targetRepoRef}`,
  );
  const applied = await applyFixesToCopy(
    request.targetRepoRef,
    request.applications,
    options.apply,
  );

  try {
    // 1b. Stage the property test files from a spec root INTO the fixed copy
    //     (the copy is mounted in place, so the files must live inside it).
    if (options.specRoot && request.properties.length > 0) {
      await stagePropertiesInto(
        applied.targetRepoCopyPath,
        options.specRoot,
        request.properties,
        log,
      );
    }

    // 2. Re-execute the SAME properties against the COPY, tagged post_fix (R8.3).
    const postFixRequest: PropertyExecutionRequest = {
      targetRepoRef: applied.targetRepoCopyPath,
      properties: request.properties,
      phase: "post_fix",
    };
    log(
      `Re-executing ${request.properties.length} propert` +
        `${request.properties.length === 1 ? "y" : "ies"} against the ` +
        `Target_Repo_Copy ${applied.targetRepoCopyPath} (phase=post_fix)`,
    );
    // The fixed copy IS already a fresh throwaway (made by applyFixesToCopy),
    // and it carries the fixes. Mount it in place — copying it again in
    // executeProperties would both waste a copy and DROP the applied fixes.
    const postFixExecution = await executeProperties(postFixRequest, {
      ...options.execute,
      mountInPlace: true,
    });

    // Index the post-fix results by propertyId for pairing.
    const postByProperty = new Map<string, ActualResult>();
    for (const result of postFixExecution.results) {
      postByProperty.set(result.propertyId, result);
    }

    // 3. Pair Pre↔Post per property and classify (R8.4, R8.5–R8.7).
    const outcomes: PropertyFixOutcome[] = [];
    const transitions: PropertyTransition[] = [];
    const skippedPropertyIds: string[] = [];
    for (const property of request.properties) {
      const preFixResult = request.preFixResults[property.id];
      const postFixResult = postByProperty.get(property.id);

      const preVerdict = verdictOf(preFixResult);
      const postVerdict = verdictOf(postFixResult);

      // A transition is only defined between two PASS/FAIL verdicts (R8.5). A
      // non-VERDICT on either side is NOT fabricated into a transition.
      if (preVerdict !== null && postVerdict !== null) {
        const transition = classifyTransition(
          preVerdict,
          postVerdict,
          property.id,
        );
        transitions.push(transition);
        outcomes.push({
          propertyId: property.id,
          preFixResult,
          postFixResult,
          transition,
        });
        log(`Property ${property.id}: ${preVerdict} → ${postVerdict} = ${transition.classification}`);
      } else {
        skippedPropertyIds.push(property.id);
        outcomes.push({ propertyId: property.id, preFixResult, postFixResult });
        log(
          `Property ${property.id}: no PASS/FAIL pair ` +
            `(pre=${preFixResult?.outcome ?? "none"}, ` +
            `post=${postFixResult?.outcome ?? "none"}) — no transition`,
        );
      }
    }

    return {
      postFixExecution,
      outcomes,
      transitions,
      skippedPropertyIds,
      targetRepoCopyPath: applied.targetRepoCopyPath,
      appliedFixTaskIds: applied.appliedFixTaskIds,
    };
  } finally {
    // 4. Clean up the throwaway copy unless the caller wants to keep it.
    if (!options.keepCopy) {
      await cleanupTargetRepoCopy(applied.targetRepoCopyPath);
    }
  }
}
