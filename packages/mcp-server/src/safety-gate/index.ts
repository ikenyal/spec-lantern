/**
 * @spec-lantern/mcp-server — the Safety Gate (task 8.1).
 *
 * The MCP_Server is the single chokepoint through which any Target_Repo code
 * can reach execution, and host safety is the product's core guarantee: no
 * Target_Repo process, script, or build step ever runs in the host process or
 * host shell (R12.1). The Safety Gate is the FIRST of the three enforcement
 * layers that uphold that guarantee (the runner boundary and the no-fallback
 * invariant are the other two, tasks 8.2 / 9):
 *
 *   1. **Safety Gate (this module) — PRE-execution classification.** Every
 *      Property_Execution_Request and every fix-application request passes
 *      through this gate BEFORE anything runs. The gate classifies the
 *      operation: if it would run Target_Repo code anywhere other than the
 *      Isolated_Runner — i.e. in the host process or host shell — the gate
 *      REJECTS it before any code runs, reports a `SAFETY_VIOLATION`, and the
 *      host filesystem and process state are left unchanged (R12.4). An
 *      accepted operation always targets the runner (R5.2, R12.1).
 *   2. Runner boundary — enforced during execution by the Isolated_Runner
 *      (`../runner/`), out of scope for this module.
 *   3. No-fallback invariant — a runner that cannot be created aborts with
 *      `RUNNER_UNAVAILABLE`, never host execution (task 8.2 / R5.8, R12.5).
 *
 * DESIGN DISCIPLINE — this module is PURE / DECISION-ONLY.
 *  - It is a CLASSIFIER, not an executor. It inspects a request and RETURNS a
 *    {@link SafetyDecision}. It NEVER spawns a process, writes a file, imports
 *    or requires a test file, or touches the host in any observable way. Being
 *    pure is exactly what lets it run "before anything runs" and leave host
 *    state unchanged: there is no host state to change here.
 *  - It is the layer that DECIDES whether a request is even allowed to reach
 *    the runner. Enforcing container-not-host AT execution time is the runner's
 *    job (`../runner/podman-runner.ts`); this gate is the separate, earlier
 *    decision about admissibility. The two are complementary, not redundant.
 *  - It reuses the closed `ActualResult` union from `@spec-lantern/types`: a
 *    rejection is surfaced as the existing `SAFETY_VIOLATION` outcome shape
 *    (`{ propertyId, outcome: "SAFETY_VIOLATION", reason }`). This module never
 *    invents a new result shape (R12.4).
 *  - CLOSED reason union. {@link SafetyViolationCode} enumerates every way a
 *    request can be host-bound; a caller can exhaustively `switch` on it.
 *
 * Requirements traceability: 5.2, 12.1, 12.4.
 */
import type {
  ActualResult,
  CorrectnessProperty,
  FixTask,
  PropertyExecutionRequest,
} from "@spec-lantern/types";

/* -------------------------------------------------------------------------- */
/* Gate inputs — the operations the gate classifies                          */
/* -------------------------------------------------------------------------- */

/**
 * A fix-application request as passed to the `apply_fixes_and_reexecute` MCP
 * tool (see design.md tool table). Like a Property_Execution_Request it carries
 * a target reference and the properties to execute, plus the Fix_Tasks to apply
 * to the Target_Repo_Copy first. It is subject to the SAME gate: fixes and the
 * re-execution they trigger must run in the runner, never on the host.
 */
export interface FixApplicationRequest {
  /** The Target_Repo_Copy the fixes apply to (never the original; R8.2). */
  targetRepoCopyRef: string;
  /** The Kiro-authored fixes to apply to the copy before re-execution. */
  fixTasks: FixTask[];
  /** The Correctness_Properties to re-execute after the fixes. */
  properties: CorrectnessProperty[];
}

/**
 * The closed set of operations the Safety Gate classifies. Tagged so a caller
 * (and the gate) can discriminate without structural guessing. Every operation
 * that could cause Target_Repo code to execute flows through this union.
 */
export type GateOperation =
  | { kind: "property_execution"; request: PropertyExecutionRequest }
  | { kind: "fix_application"; request: FixApplicationRequest };

/* -------------------------------------------------------------------------- */
/* Decision vocabulary (closed union)                                         */
/* -------------------------------------------------------------------------- */

/**
 * The only execution target the gate will ever accept. Accepted operations
 * ALWAYS target the Isolated_Runner (R5.2, R12.1); there is deliberately no
 * "host" member — a host target is never an accepted outcome, it is a
 * violation.
 */
export type ExecutionTarget = "isolated_runner";

/**
 * Closed enumeration of every reason a request is host-bound and therefore
 * rejected. Each maps to a concrete, inspectable property of the request that
 * would route Target_Repo code to the host process or host shell. A caller can
 * exhaustively `switch` on these to explain a rejection.
 */
export type SafetyViolationCode =
  /**
   * The target reference names the host working tree / an absolute host path
   * that is NOT a runner-mountable target, or uses a scheme that denotes host
   * execution (e.g. a `host:` reference). The only safe references are opaque
   * target-repo references the runner mounts read-confined.
   */
  | "HOST_TARGET_REFERENCE"
  /**
   * The target reference is empty/blank. An operation with no runner-mountable
   * target cannot be routed to the runner; admitting it risks a default-to-host
   * path, so it is rejected before anything runs.
   */
  | "MISSING_TARGET_REFERENCE"
  /**
   * A requested operation explicitly asks to run in the host process or host
   * shell (e.g. a property whose embedded component path or a fix task that
   * encodes a host shell/command/build-step execution). The gate never lets
   * such an operation through to run on the host.
   */
  | "HOST_EXECUTION_DIRECTIVE";

/** A single reason a request was rejected, with the offending detail. */
export interface SafetyViolation {
  code: SafetyViolationCode;
  /** Human-readable explanation naming what was host-bound and why. */
  reason: string;
}

/**
 * The gate's verdict for one operation. Exactly one of two shapes:
 *  - `accepted: true`  — the operation targets the Isolated_Runner and may
 *    proceed to the runner (R5.2); `target` is always `"isolated_runner"`.
 *  - `accepted: false` — the operation is host-bound; it MUST NOT run. The gate
 *    produced this decision WITHOUT running anything, so the host filesystem and
 *    process state are unchanged (R12.4). `violations` is non-empty and
 *    `results` carries one `SAFETY_VIOLATION` {@link ActualResult} per property
 *    in the request, ready to return across the MCP boundary unchanged.
 */
export type SafetyDecision =
  | { accepted: true; target: ExecutionTarget }
  | {
      accepted: false;
      violations: SafetyViolation[];
      /** One SAFETY_VIOLATION per property (reuses the closed ActualResult union). */
      results: Extract<ActualResult, { outcome: "SAFETY_VIOLATION" }>[];
    };

/* -------------------------------------------------------------------------- */
/* Classification primitives (pure)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Reference schemes that unambiguously denote host execution. A target or
 * component reference beginning with any of these routes code to the host and
 * is never runner-mountable.
 */
const HOST_EXECUTION_SCHEMES = ["host:", "shell:", "exec:", "file://localhost"] as const;

/**
 * Tokens that, when they appear as a scheme-like prefix on a fix directive,
 * encode "run this in the host shell / as a host process or build step". A
 * Fix_Task is a DESCRIPTION of a change applied to the copy inside the runner;
 * a task whose description is actually a host command directive is host-bound.
 */
const HOST_COMMAND_PREFIXES = [
  "host:",
  "shell:",
  "exec:",
  "sh -c",
  "bash -c",
  "zsh -c",
  "cmd /c",
  "powershell",
  "npm run ",
  "node ",
  "npx ",
  "./",
] as const;

/** Trimmed, lower-cased view of a string for prefix/scheme testing. */
function normalized(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Classify a target reference (the repo/copy the operation runs against).
 *
 * A safe reference is a non-empty, opaque target-repo reference the runner can
 * mount and read-confine. A reference is host-bound when it is blank, or when
 * it uses a scheme that denotes host execution. Returns `null` when the
 * reference is safe.
 *
 * NOTE: this is intentionally conservative about what counts as host-bound
 * rather than trying to validate a filesystem — the gate is pure and must not
 * touch disk. It rejects references that DECLARE host execution; it does not
 * try to resolve paths. Path/boundary confinement of an accepted target is the
 * runner's job (R12.6), not the gate's.
 */
function classifyTargetReference(reference: string): SafetyViolation | null {
  const ref = normalized(reference);
  if (ref.length === 0) {
    return {
      code: "MISSING_TARGET_REFERENCE",
      reason:
        "operation has no target reference; it cannot be routed to the Isolated_Runner and is rejected before anything runs",
    };
  }
  for (const scheme of HOST_EXECUTION_SCHEMES) {
    if (ref.startsWith(scheme)) {
      return {
        code: "HOST_TARGET_REFERENCE",
        reason: `target reference "${reference}" uses host-execution scheme "${scheme}"; Target_Repo code may run only inside the Isolated_Runner`,
      };
    }
  }
  return null;
}

/**
 * Classify a single Correctness_Property. A property is host-bound when its
 * embedded component reference declares host execution (a `component_rendered`
 * property is evaluated by rendering inside the runner's jsdom harness, never
 * by invoking a host process). Returns `null` when the property is safe.
 */
function classifyProperty(property: CorrectnessProperty): SafetyViolation | null {
  const componentPath = property.embeddedComponentLogic?.componentPath;
  if (componentPath !== undefined) {
    const path = normalized(componentPath);
    for (const scheme of HOST_EXECUTION_SCHEMES) {
      if (path.startsWith(scheme)) {
        return {
          code: "HOST_EXECUTION_DIRECTIVE",
          reason: `property "${property.id}" declares a host-execution component reference "${componentPath}"; component logic is rendered inside the runner, never on the host`,
        };
      }
    }
  }
  return null;
}

/**
 * Classify a single Fix_Task. A Fix_Task describes a change applied to the
 * Target_Repo_Copy INSIDE the runner; a task whose description is actually a
 * host shell/command/build-step directive would run Target_Repo code on the
 * host and is rejected. Returns `null` when the task is safe.
 */
function classifyFixTask(task: FixTask): SafetyViolation | null {
  const description = normalized(task.description);
  for (const prefix of HOST_COMMAND_PREFIXES) {
    if (description.startsWith(prefix)) {
      return {
        code: "HOST_EXECUTION_DIRECTIVE",
        reason: `fix task "${task.id}" encodes a host command/build-step directive ("${task.description}"); fixes are applied to the copy inside the runner, never run on the host`,
      };
    }
  }
  return null;
}

/** De-duplicate violations by code, keeping first-seen order and reason. */
function dedupeViolations(violations: SafetyViolation[]): SafetyViolation[] {
  const seen = new Set<SafetyViolationCode>();
  const out: SafetyViolation[] = [];
  for (const violation of violations) {
    if (!seen.has(violation.code)) {
      seen.add(violation.code);
      out.push(violation);
    }
  }
  return out;
}

/**
 * Build the rejection decision: one `SAFETY_VIOLATION` {@link ActualResult} per
 * property in the request (so each property carries the block), reusing the
 * closed union from `@spec-lantern/types`. The `reason` concatenates the
 * distinct violation reasons. No side effects — host state is untouched (R12.4).
 */
function reject(
  properties: CorrectnessProperty[],
  violations: SafetyViolation[],
): Extract<SafetyDecision, { accepted: false }> {
  const distinct = dedupeViolations(violations);
  const reason = distinct.map((v) => v.reason).join("; ");
  const results: Extract<ActualResult, { outcome: "SAFETY_VIOLATION" }>[] =
    properties.map((property) => ({
      propertyId: property.id,
      outcome: "SAFETY_VIOLATION",
      reason,
    }));
  return { accepted: false, violations: distinct, results };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Classify a {@link GateOperation} BEFORE anything runs and return the gate's
 * {@link SafetyDecision}.
 *
 * This is the pre-execution chokepoint for host safety (R5.2, R12.1, R12.4). It
 * is PURE: it never spawns a process, writes a file, or executes a test; it only
 * inspects the request and decides. An accepted operation is cleared to proceed
 * to the Isolated_Runner (`target: "isolated_runner"`). A rejected operation is
 * host-bound and carries one `SAFETY_VIOLATION` result per property — the caller
 * returns those unchanged and never dispatches to the runner. Because the gate
 * runs before any execution and has no side effects, a rejection leaves the host
 * filesystem and process state exactly as they were (R12.4).
 *
 * @param operation the property-execution or fix-application operation to classify
 * @returns an accept (runner-targeted) or reject (host-bound) decision
 */
export function classifyOperation(operation: GateOperation): SafetyDecision {
  const violations: SafetyViolation[] = [];

  const targetReference =
    operation.kind === "property_execution"
      ? operation.request.targetRepoRef
      : operation.request.targetRepoCopyRef;

  const targetViolation = classifyTargetReference(targetReference);
  if (targetViolation !== null) {
    violations.push(targetViolation);
  }

  for (const property of operation.request.properties) {
    const propertyViolation = classifyProperty(property);
    if (propertyViolation !== null) {
      violations.push(propertyViolation);
    }
  }

  if (operation.kind === "fix_application") {
    for (const task of operation.request.fixTasks) {
      const taskViolation = classifyFixTask(task);
      if (taskViolation !== null) {
        violations.push(taskViolation);
      }
    }
  }

  if (violations.length > 0) {
    return reject(operation.request.properties, violations);
  }
  return { accepted: true, target: "isolated_runner" };
}

/**
 * Convenience wrapper: classify a {@link PropertyExecutionRequest} directly.
 * Equivalent to `classifyOperation({ kind: "property_execution", request })`.
 */
export function classifyPropertyExecution(
  request: PropertyExecutionRequest,
): SafetyDecision {
  return classifyOperation({ kind: "property_execution", request });
}

/**
 * Convenience wrapper: classify a {@link FixApplicationRequest} directly.
 * Equivalent to `classifyOperation({ kind: "fix_application", request })`.
 */
export function classifyFixApplication(
  request: FixApplicationRequest,
): SafetyDecision {
  return classifyOperation({ kind: "fix_application", request });
}

/** Narrowing helper: `true` iff the gate accepted the operation. */
export function isAccepted(
  decision: SafetyDecision,
): decision is Extract<SafetyDecision, { accepted: true }> {
  return decision.accepted;
}
