/**
 * The MCP transport + `execute_properties` tool wiring (task 10.1).
 *
 * This module exposes the MCP_Server over the MCP boundary using the MCP
 * TypeScript SDK and registers the `execute_properties` tool — the contract the
 * Kiro_Power calls to run Correctness_Properties against a Target_Repo inside
 * the Isolated_Runner (design "Component 2: MCP_Server", tool table).
 *
 * SEPARATION OF CONCERNS. The gate → runner → collect orchestration is pure
 * TypeScript in {@link ./orchestrator/index.ts}; this module is the THIN
 * adapter that:
 *  1. builds the SDK {@link McpServer} and declares the `execute_properties`
 *     tool with an input schema that mirrors {@link PropertyExecutionRequest};
 *  2. in the tool handler, reconstructs the typed request and delegates to
 *     {@link executeProperties};
 *  3. returns the {@link PropertyExecutionResult} both as the tool's structured
 *     content and as a JSON text block (so MCP clients that do not read
 *     structured content still receive the result).
 *
 * The handler NEVER runs Target_Repo code itself — it only calls the
 * orchestrator, which routes through the Safety Gate and the Isolated_Runner.
 *
 * TRANSPORT. The MVP uses the stdio transport ({@link StdioServerTransport}): a
 * local Kiro_Power launches the server as a subprocess and speaks MCP over
 * stdin/stdout. {@link createMcpServer} builds and configures the server
 * (testable without a transport); {@link startStdioServer} connects it to stdio.
 *
 * SCOPE. Six tools are wired here, each delegating to its pure orchestrator
 * behind this same transport seam: `execute_properties` (task 10.1),
 * `replay_counterexample` (task 11.1), `apply_fixes_and_reexecute` (task 15.2),
 * `lock_prediction` (the prediction lock, R3.4/R3.5),
 * `supersede_prediction_lock` (archive a lock + re-lock an edited property file,
 * keeping the predicted verdict), and `compare_predictions`
 * (locks vs a persisted execution result). The `apply_fixes_and_reexecute`
 * handler delegates to {@link applyFixesAndReexecute}, which copies the
 * Target_Repo, applies fixes to the copy (task 15.1), and re-executes the
 * properties against the copy via {@link executeProperties}.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  SPEC_LANTERN,
  type ActualResult,
  type PropertyExecutionRequest,
  type PropertyExecutionResult,
} from "@spec-lantern/types";
import {
  executeProperties,
  type ExecutePropertiesOptions,
} from "./orchestrator/index.js";
import {
  replayCounterexample,
  type ReplayCounterexampleOptions,
  type ReplayCounterexampleRequest,
} from "./orchestrator/replay.js";
import {
  applyFixesAndReexecute,
  type ApplyFixesAndReexecuteOptions,
  type ApplyFixesAndReexecuteRequest,
} from "./revive/apply-fixes-reexecute.js";
import {
  lockPrediction,
  supersedePredictionLock,
  type LockPredictionOptions,
  type LockTarget,
} from "./prediction-lock/index.js";
import { checkPropertyLockDrift } from "./execute-lock-guard/index.js";
import { deriveProperties, deriveProperty } from "./spec-derive/index.js";
import { writeToolResult } from "./results/persist.js";
import {
  comparePredictions,
  type ComparePredictionsRequest,
} from "./compare-predictions/index.js";

/* -------------------------------------------------------------------------- */
/* Input schema — mirrors PropertyExecutionRequest                            */
/* -------------------------------------------------------------------------- */

/**
 * Zod schema for one Correctness_Property as carried in a request. It mirrors
 * the serializable `CorrectnessProperty` type (task 2.1). `mockedData` is
 * `unknown` by design (props-driven component data), so it is modeled as an
 * unconstrained value.
 */
const correctnessPropertySchema = z.object({
  id: z.string(),
  claimId: z.string(),
  title: z.string(),
  statement: z.string(),
  kind: z.enum(["function", "component_rendered"]),
  embeddedComponentLogic: z
    .object({
      componentPath: z.string(),
      mockedData: z.unknown(),
    })
    .optional(),
  validatesRequirements: z.array(z.string()),
});

/**
 * Zod shape for the `execute_properties` tool input — the serializable
 * {@link PropertyExecutionRequest}. Declared as a raw shape (not a wrapping
 * `z.object`) because the SDK's `registerTool` takes the field map directly and
 * surfaces each field as a named tool argument.
 */
const executePropertiesInputShape = {
  /**
   * Path to the ORIGINAL Target_Repo. The server COPIES this into a fresh
   * throwaway working copy and mounts the COPY (never the original), so the
   * user's repo stays byte-for-byte unchanged (the install phase writes
   * `node_modules`/lock files into whatever is mounted).
   */
  targetRepoRef: z.string(),
  /**
   * The Correctness_Properties to execute. OPTIONAL: when omitted AND `specRoot`
   * is given, the server DERIVES them from the spec on disk (claims.json +
   * properties/), so the caller need not hand-write them.
   */
  properties: z.array(correctnessPropertySchema).optional(),
  /**
   * Which pipeline phase this execution belongs to. OPTIONAL: defaults to
   * `"initial"` when omitted — the common first-run case — so a caller need not
   * spell it out. `"post_fix"` must still be passed explicitly for a re-run.
   */
  phase: z.enum(["initial", "post_fix"]).optional(),
  /**
   * OPTIONAL spec root holding `properties/property-{n}.{claimId}.test.ts`. When
   * provided, the server stages each property's test file from here INTO the
   * working copy itself, so the caller need not place files by hand.
   */
  specRoot: z.string().optional(),
  /**
   * OPTIONAL per-property test-phase timeout in seconds (the no-network test
   * phase ceiling). Defaults to 30 (R5.7) when omitted. A `component_rendered`
   * property that renders a real component in jsdom for its ≥100 fast-check
   * iterations can legitimately need more than 30s — especially on the first,
   * cold run — so raise this (e.g. 180) when a component property comes back
   * TIMEOUT rather than a verdict. Does NOT affect the install phase, which has
   * its own generous timeout.
   */
  timeoutSeconds: z.number().int().positive().optional(),
} as const;

/**
 * Zod schema for an {@link ExecutionContext} — the recorded reproduction values
 * (Random_Seed, timezone, Fixed_Current_Time). Mirrors the serializable type
 * (task 2.1). `randomSeed` is an integer (fast-check's seed).
 */
const executionContextSchema = z.object({
  randomSeed: z.number().int(),
  timezone: z.string(),
  fixedCurrentTime: z.string(),
});

/**
 * Zod schema for a {@link Counterexample} — mirrors the serializable type
 * (task 2.1). `input`/`observedOutput` are `unknown` by design (arbitrary
 * triggering values), so they are modeled as unconstrained.
 */
const counterexampleSchema = z.object({
  propertyId: z.string(),
  input: z.unknown(),
  observedOutput: z.unknown(),
  executionContext: executionContextSchema,
});

/**
 * Zod schema for the closed {@link ActualResult} union — one shape per outcome.
 * Mirrors the discriminated union in `@spec-lantern/types`; `outcome` is the
 * discriminant. Used to carry the Pre_Fix_Results into
 * `apply_fixes_and_reexecute` (R8.4) without re-executing the original.
 */
const actualResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    propertyId: z.string(),
    outcome: z.literal("VERDICT"),
    verdict: z.enum(["PASS", "FAIL"]),
    counterexample: counterexampleSchema.optional(),
  }),
  z.object({
    propertyId: z.string(),
    outcome: z.literal("TIMEOUT"),
    limitSeconds: z.number(),
  }),
  z.object({
    propertyId: z.string(),
    outcome: z.literal("EXECUTION_ERROR"),
    reason: z.string(),
  }),
  z.object({
    propertyId: z.string(),
    outcome: z.literal("RUNNER_UNAVAILABLE"),
    reason: z.string(),
  }),
  z.object({
    propertyId: z.string(),
    outcome: z.literal("SAFETY_VIOLATION"),
    reason: z.string(),
  }),
]);

/**
 * Zod schema for a {@link FixTask}. `appliesTo` is pinned to the
 * `"Target_Repo_Copy"` literal — the apply step re-checks this at runtime
 * (R8.2) so the original is never a write target.
 */
const fixTaskSchema = z.object({
  id: z.string(),
  confirmedBugPropertyId: z.string(),
  description: z.string(),
  appliesTo: z.literal("Target_Repo_Copy"),
});

/**
 * Zod schema for a {@link FileEdit} — the deterministic, serializable
 * realization of (part of) a fix on the copy: write-full-contents or delete, by
 * repo-relative path (task 15.1).
 */
const fileEditSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("write"),
    path: z.string(),
    contents: z.string(),
  }),
  z.object({ kind: z.literal("delete"), path: z.string() }),
]);

/**
 * Zod schema for a {@link FixApplication} — a Fix_Task paired with the concrete
 * {@link FileEdit}s that realize it on the Target_Repo_Copy (task 15.1).
 */
const fixApplicationSchema = z.object({
  fixTask: fixTaskSchema,
  edits: z.array(fileEditSchema),
});

/**
 * Zod shape for the `apply_fixes_and_reexecute` tool input. The design tool
 * table names it `{ targetRepoCopyRef, fixTasks[], properties[] }`; in this
 * codebase the concrete realization of a fix is a {@link FixApplication}
 * (Fix_Task + {@link FileEdit}s, since a Fix_Task's description is natural
 * language), and the copy is PRODUCED here from the original rather than
 * supplied — so the input carries `targetRepoRef` (the original to copy),
 * `applications` (the realizable fixes), `properties` (the SAME set to re-run),
 * and `preFixResults` (the Pre_Fix_Result per propertyId the caller already has,
 * keyed as a serializable object, R8.4). Declared as a raw shape so each field
 * is a named tool argument, matching the `execute_properties` convention.
 */
const applyFixesAndReexecuteInputShape = {
  /** Path to the ORIGINAL Target_Repo to copy from (never executed on host). */
  targetRepoRef: z.string(),
  /** The Fix_Tasks + their concrete edits to realize on the copy (15.1). */
  applications: z.array(fixApplicationSchema),
  /**
   * The SAME Correctness_Properties to re-execute against the fixed copy.
   * OPTIONAL: when omitted AND `specRoot` is given, the server DERIVES them from
   * the spec on disk, so the caller need not hand-write them.
   */
  properties: z.array(correctnessPropertySchema).optional(),
  /**
   * Pre_Fix_Result per propertyId — the original execution outcome (R8.4).
   * Accepts BOTH shapes `execute_properties` can hand back: a `record` keyed by
   * propertyId, OR the `array` of ActualResult exactly as it returns at
   * `.results`. An array is normalized to a record (keyed by `propertyId`)
   * internally.
   */
  preFixResults: z.union([
    z.record(z.string(), actualResultSchema),
    z.array(actualResultSchema),
  ]),
  /**
   * OPTIONAL spec root holding `properties/property-{n}.{claimId}.test.ts`. When
   * provided, the server stages each property's test file from here INTO the
   * fixed copy before re-execution, so the caller need not place files by hand.
   */
  specRoot: z.string().optional(),
} as const;

/**
 * Zod shape for the `replay_counterexample` tool input (design tool table:
 * `{ property, executionContext }`, plus the `targetRepoRef` the runner mounts).
 * Declared as a raw shape so each field is a named tool argument, matching the
 * `execute_properties` convention.
 */
const replayCounterexampleInputShape = {
  /**
   * Path to the ORIGINAL Target_Repo. The server COPIES this into a fresh
   * throwaway working copy and mounts the COPY (never the original), exactly as
   * `execute_properties` does, so the user's repo stays unchanged.
   */
  targetRepoRef: z.string(),
  /**
   * The single Correctness_Property to replay. OPTIONAL: when omitted AND
   * `specRoot` is given, the server DERIVES it from the spec (the property whose
   * id matches the counterexample's propertyId is identified via `propertyId`).
   */
  property: correctnessPropertySchema.optional(),
  /**
   * The id of the property to replay — REQUIRED when `property` is omitted and
   * derivation from `specRoot` is used, so the server knows which derived
   * property to pick. Ignored when `property` is supplied explicitly.
   */
  propertyId: z.string().optional(),
  /** The Execution_Context recorded with the original Counterexample (R6.2). */
  executionContext: executionContextSchema,
  /**
   * OPTIONAL spec root holding `properties/property-{n}.{claimId}.test.ts`. When
   * provided, the server stages the property's test file from here INTO the
   * working copy itself.
   */
  specRoot: z.string().optional(),
} as const;

/**
 * Zod shape for the `lock_prediction` tool input. The prediction lock (R3.4,
 * R3.5) is taken over the ON-DISK artifacts: the Predicted_Result file and the
 * Correctness_Property test file it refers to. Those are located by the canonical
 * layout from `@spec-lantern/types` under a spec root, keyed by Claim id +
 * property number. So the tool input mirrors {@link LockTarget}: the spec root
 * holding the artifacts, the Claim id, and the property number. Declared as a raw
 * shape so each field is a named tool argument, matching the other tools.
 */
const lockPredictionInputShape = {
  /** Spec root holding claims/properties/predictions/locks. */
  specRoot: z.string(),
  /** The Claim id whose property prediction is being locked. */
  claimId: z.string(),
  /** The property number (`property-{n}.{claimId}.*`). */
  propertyNumber: z.number().int().positive(),
} as const;

/**
 * Zod shape for the `supersede_prediction_lock` tool input (GAP 1). A supersede
 * archives the active lock and re-locks the EDITED property source keeping the
 * predicted verdict, so it is located by the same coordinates as a lock plus a
 * non-empty `reason` recording why the property source legitimately changed.
 */
const supersedePredictionLockInputShape = {
  /** Spec root holding claims/properties/predictions/locks. */
  specRoot: z.string(),
  /** The Claim id whose property lock is being superseded. */
  claimId: z.string(),
  /** The property number (`property-{n}.{claimId}.*`). */
  propertyNumber: z.number().int().positive(),
  /** Why the property test file legitimately changed. Required, non-empty. */
  reason: z.string().min(1),
} as const;

/**
 * Zod shape for the `compare_predictions` tool input (change 3). Reads the
 * LOCKED predictions under `specRoot` and a persisted execution result at
 * `resultsPath`, runs the Comparison Engine, optionally groups symptoms under a
 * root cause, and writes `<specRoot>/comparison.json`. Predictions come ONLY
 * from the locks, never from the caller.
 */
const comparePredictionsInputShape = {
  /** Spec root holding the locks and receiving `comparison.json`. */
  specRoot: z.string(),
  /** Path to a persisted execution result JSON (what a tool wrote to results/). */
  resultsPath: z.string(),
  /**
   * OPTIONAL root-cause → symptoms map. Groups symptom comparisons under their
   * root cause and counts a lie once per root cause.
   */
  rootCauses: z.record(z.string(), z.array(z.string())).optional(),
} as const;

/* -------------------------------------------------------------------------- */
/* Structured schema-error messages with a minimal valid example (change 1)   */
/* -------------------------------------------------------------------------- */

/**
 * A minimal valid example of each tool's expected input, used in the
 * structured error a handler returns when the derived/supplied input is
 * missing or invalid. Defined in ONE place so the example text stays correct
 * and consistent (change 1). The examples are deliberately tiny but complete.
 */
function minimalExampleFor(
  tool:
    | "execute_properties"
    | "replay_counterexample"
    | "apply_fixes_and_reexecute"
    | "compare_predictions",
): string {
  const oneProperty = {
    id: "property-1.claim-a",
    claimId: "claim-a",
    title: "Example property",
    statement: "for all x, holds",
    kind: "function",
    validatesRequirements: [],
  };
  const oneActual = {
    propertyId: "property-1.claim-a",
    outcome: "VERDICT",
    verdict: "FAIL",
  };
  switch (tool) {
    case "execute_properties":
      return JSON.stringify(
        {
          targetRepoRef: "/path/to/target",
          // Omit `properties` to derive from the spec when `specRoot` is given.
          properties: [oneProperty],
          phase: "initial",
          specRoot: "/path/to/spec",
        },
        null,
        2,
      );
    case "replay_counterexample":
      return JSON.stringify(
        {
          targetRepoRef: "/path/to/target",
          // Omit `property` and pass `propertyId` to derive from the spec.
          property: oneProperty,
          executionContext: {
            randomSeed: 123456789,
            timezone: "Asia/Tokyo",
            fixedCurrentTime: "2020-01-15T00:00:00.000Z",
          },
          specRoot: "/path/to/spec",
        },
        null,
        2,
      );
    case "apply_fixes_and_reexecute":
      return JSON.stringify(
        {
          targetRepoRef: "/path/to/target",
          applications: [
            {
              fixTask: {
                id: "fix-1",
                confirmedBugPropertyId: "property-1.claim-a",
                description: "example fix",
                appliesTo: "Target_Repo_Copy",
              },
              edits: [
                { kind: "write", path: "src/x.ts", contents: "export {};\n" },
              ],
            },
          ],
          // Omit `properties` to derive from the spec when `specRoot` is given.
          properties: [oneProperty],
          // preFixResults accepts EITHER a record keyed by propertyId…
          preFixResults: { "property-1.claim-a": oneActual },
          // …OR an array (exactly execute_properties' `.results`):
          // preFixResults: [oneActual],
          specRoot: "/path/to/spec",
        },
        null,
        2,
      );
    case "compare_predictions":
      return JSON.stringify(
        {
          specRoot: "/path/to/spec",
          resultsPath: "/path/to/spec/results/<timestamp>-execute_properties.json",
          // Optional: group symptoms under a root cause.
          rootCauses: { "property-1.claim-a": ["property-2.claim-b"] },
        },
        null,
        2,
      );
  }
}

/** Build an MCP tool-error result whose text includes a minimal valid example. */
function schemaErrorResult(
  tool:
    | "execute_properties"
    | "replay_counterexample"
    | "apply_fixes_and_reexecute"
    | "compare_predictions",
  reason: string,
): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `${reason}\n\nExpected input for ${tool} — a minimal valid ` +
          `example:\n${minimalExampleFor(tool)}`,
      },
    ],
  };
}

/**
 * Shared finalizer for the executing tools (change 2). When `specRoot` is given,
 * it persists the RAW `result` verbatim to `<specRoot>/results/<stamp>-<tool>.
 * json` and then returns the result ANNOTATED with the written `resultsPath`
 * (both as structured content and as a JSON text block). When no `specRoot` is
 * given, it returns the result unchanged (no persistence).
 *
 * The file on disk is the raw result WITHOUT `resultsPath` — self-contained and
 * exactly the tool's output — while the returned value carries the path so the
 * caller knows where it landed.
 */
async function finalizeToolResult(
  toolName: string,
  result: unknown,
  specRoot: string | undefined,
  options: CreateMcpServerOptions,
): Promise<{
  structuredContent: Record<string, unknown>;
  content: { type: "text"; text: string }[];
}> {
  let returned = result;
  if (specRoot !== undefined) {
    // Persist the RAW result first (self-contained), then annotate the return.
    const resultsPath = await writeToolResult(
      specRoot,
      toolName,
      result,
      options.resultsClock,
    );
    returned = { ...(result as Record<string, unknown>), resultsPath };
  }
  return {
    structuredContent: returned as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(returned) }],
  };
}

/* -------------------------------------------------------------------------- */
/* Server construction                                                        */
/* -------------------------------------------------------------------------- */

/** Options for {@link createMcpServer}, forwarded to the orchestrators. */
export interface CreateMcpServerOptions {
  /** Orchestration overrides (runner, timeout, log) for `execute_properties`. */
  execute?: ExecutePropertiesOptions;
  /** Orchestration overrides (runner, timeout, log) for `replay_counterexample`. */
  replay?: ReplayCounterexampleOptions;
  /** Orchestration overrides (runner, apply, copy retention) for `apply_fixes_and_reexecute`. */
  applyFixesAndReexecute?: ApplyFixesAndReexecuteOptions;
  /** Options (timestamp injection) for `lock_prediction`. */
  lockPrediction?: LockPredictionOptions;
  /**
   * Injectable clock for the verbatim result-persistence filename (change 2).
   * When a tool has a `specRoot`, it writes its raw result to
   * `<specRoot>/results/<utc-stamp>-<tool>.json`; this pins the timestamp so
   * tests get a deterministic filename. Defaults to `() => new Date()`.
   */
  resultsClock?: () => Date;
}

/**
 * Build and configure the MCP {@link McpServer} with the `execute_properties`
 * tool registered. Returned unconnected so a caller can connect it to any
 * transport (stdio in production, an in-memory pair in tests).
 *
 * The `execute_properties` handler reconstructs the typed
 * {@link PropertyExecutionRequest} from the validated arguments and delegates to
 * {@link executeProperties}, which routes through the Safety Gate and the
 * Isolated_Runner and returns the per-property {@link PropertyExecutionResult}.
 * The result is returned BOTH as `structuredContent` and as a JSON text block.
 */
export function createMcpServer(
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: SPEC_LANTERN,
    version: "0.0.0",
  });

  server.registerTool(
    "execute_properties",
    {
      title: "Execute Correctness_Properties in the Isolated_Runner",
      description:
        "Run each Correctness_Property against the Target_Repo inside the " +
        "rootless-Podman Isolated_Runner. The request is first classified by " +
        "the Safety Gate (host-bound requests are rejected with a safety " +
        "violation and never reach a runner); accepted properties run through " +
        "the two-phase lifecycle (dependency install, then the no-network test " +
        "phase). Returns exactly PASS or FAIL per property on normal " +
        "completion; timeouts, execution errors, runner-unavailability, and " +
        "safety violations are returned as their own distinct outcomes, never " +
        "encoded as PASS/FAIL.",
      inputSchema: executePropertiesInputShape,
    },
    async (args) => {
      const specRoot = args.specRoot ?? options.execute?.specRoot;

      // Resolve the properties: explicit when supplied, else DERIVED from the
      // spec when a specRoot is given (change 1). A structured error-with-example
      // is returned when neither is available or derivation fails.
      let properties = args.properties;
      if (properties === undefined) {
        if (specRoot === undefined) {
          return schemaErrorResult(
            "execute_properties",
            "`properties` was omitted and no `specRoot` was given, so the " +
              "properties could not be derived.",
          );
        }
        const derived = await deriveProperties(specRoot);
        if (derived.properties === null) {
          return schemaErrorResult(
            "execute_properties",
            `Could not derive properties from specRoot "${specRoot}": ` +
              `${derived.issue?.message ?? "unknown error"}`,
          );
        }
        properties = derived.properties;
      }

      // GAP 1 — execute-time lock guard. When a spec root is known, refuse to
      // run any property whose current test-file source drifted from its locked
      // `propertyContentHash` (an edit after locking with no supersede). Only
      // the allowed properties are dispatched; each refused property gets a
      // distinct NON-verdict EXECUTION_ERROR result so it is surfaced honestly
      // and never mistaken for PASS/FAIL. The hashes actually run against are
      // attached to the result so a persisted run is traceable to the exact
      // source.
      let dispatchProperties = properties;
      let refusedResults: ActualResult[] = [];
      let propertyContentHashes: Record<string, string> | undefined;
      if (specRoot !== undefined) {
        const drift = await checkPropertyLockDrift({ specRoot, properties });
        dispatchProperties = drift.allowed;
        refusedResults = drift.refused.map((r) => ({
          propertyId: r.propertyId,
          outcome: "EXECUTION_ERROR" as const,
          reason: r.reason,
        }));
        propertyContentHashes = drift.propertyContentHashes;
      }

      const request: PropertyExecutionRequest = {
        targetRepoRef: args.targetRepoRef,
        properties: dispatchProperties,
        // Default to the first-run phase when the caller omits it.
        phase: args.phase ?? "initial",
      };

      // Merge a per-call specRoot (so the server stages property files into the
      // working copy) and an optional per-call timeout over the
      // construction-time options. An explicit timeout wins; otherwise the
      // orchestrator/runner default (30s, R5.7) applies.
      const executed = await executeProperties(request, {
        ...options.execute,
        specRoot,
        timeoutSeconds: args.timeoutSeconds ?? options.execute?.timeoutSeconds,
      });

      // Merge the refused properties' non-verdict results into the response and
      // attach the recorded property-file hashes (GAP 1). Refusals are appended
      // so every requested property is represented exactly once.
      const result: PropertyExecutionResult = {
        results: [...executed.results, ...refusedResults],
        executionContexts: executed.executionContexts,
        ...(propertyContentHashes &&
        Object.keys(propertyContentHashes).length > 0
          ? { propertyContentHashes }
          : {}),
      };

      return finalizeToolResult("execute_properties", result, specRoot, options);
    },
  );

  server.registerTool(
    "replay_counterexample",
    {
      title: "Replay a Counterexample under its recorded Execution_Context",
      description:
        "Re-run a single Correctness_Property inside the Isolated_Runner with " +
        "the Execution_Context recorded for the original execution (its " +
        "Random_Seed, timezone, and Fixed_Current_Time) forced back through " +
        "the runner, so a deterministic property reproduces the Actual_Result " +
        "that was recorded originally. The replay is classified by the Safety " +
        "Gate first (host-bound replays are rejected with a safety violation " +
        "and never reach a runner) and runs through the same two-phase " +
        "lifecycle as execution. Returns the single Actual_Result the replay " +
        "produced; timeouts, execution errors, runner-unavailability, and " +
        "safety violations are returned as their own distinct outcomes, never " +
        "encoded as PASS/FAIL.",
      inputSchema: replayCounterexampleInputShape,
    },
    async (args) => {
      const specRoot = args.specRoot ?? options.replay?.specRoot;

      // Resolve the property: explicit when supplied, else DERIVED from the spec
      // by its `propertyId` when a specRoot is given (change 1).
      let property = args.property;
      if (property === undefined) {
        if (specRoot === undefined || args.propertyId === undefined) {
          return schemaErrorResult(
            "replay_counterexample",
            "`property` was omitted; to derive it, provide both a `specRoot` " +
              "and the `propertyId` of the property to replay.",
          );
        }
        const derived = await deriveProperty(specRoot, args.propertyId);
        if (derived.property === null) {
          return schemaErrorResult(
            "replay_counterexample",
            `Could not derive property "${args.propertyId}" from specRoot ` +
              `"${specRoot}": ${derived.issue?.message ?? "unknown error"}`,
          );
        }
        property = derived.property;
      }

      const request: ReplayCounterexampleRequest = {
        targetRepoRef: args.targetRepoRef,
        property,
        executionContext: args.executionContext,
      };

      const result = await replayCounterexample(request, {
        ...options.replay,
        specRoot,
      });

      return finalizeToolResult(
        "replay_counterexample",
        result,
        specRoot,
        options,
      );
    },
  );

  server.registerTool(
    "apply_fixes_and_reexecute",
    {
      title: "Apply Fix_Tasks to a copy and re-execute the properties",
      description:
        "Copy the Target_Repo into a fresh Target_Repo_Copy, apply each " +
        "Kiro-authored Fix_Task's edits ONLY to that copy (the original stays " +
        "byte-for-byte unchanged), then re-execute the SAME " +
        "Correctness_Properties against the fixed copy inside the " +
        "Isolated_Runner (phase post_fix). Pairs each property's " +
        "Pre_Fix_Result (the original execution outcome supplied by the " +
        "caller) with its Post_Fix_Result and classifies the Property_Transition: " +
        "FIXED (FAIL→PASS), NOT_RESOLVED (FAIL→FAIL), REGRESSION (PASS→FAIL), or " +
        "STILL_PASSING (PASS→PASS). A property whose pre- or post-fix result is " +
        "a non-verdict outcome (timeout, execution error, runner-unavailable, " +
        "safety violation) gets no fabricated transition and is reported as " +
        "skipped.",
      inputSchema: applyFixesAndReexecuteInputShape,
    },
    async (args) => {
      const specRoot =
        args.specRoot ?? options.applyFixesAndReexecute?.specRoot;

      // Resolve the properties: explicit when supplied, else DERIVED from the
      // spec when a specRoot is given (change 1).
      let properties = args.properties;
      if (properties === undefined) {
        if (specRoot === undefined) {
          return schemaErrorResult(
            "apply_fixes_and_reexecute",
            "`properties` was omitted and no `specRoot` was given, so the " +
              "properties could not be derived.",
          );
        }
        const derived = await deriveProperties(specRoot);
        if (derived.properties === null) {
          return schemaErrorResult(
            "apply_fixes_and_reexecute",
            `Could not derive properties from specRoot "${specRoot}": ` +
              `${derived.issue?.message ?? "unknown error"}`,
          );
        }
        properties = derived.properties;
      }

      // Normalize preFixResults: accept BOTH an array (exactly what
      // execute_properties returns at `.results`) and a record keyed by
      // propertyId (change 1). An array is keyed by each result's propertyId.
      const preFixResults: Record<string, ActualResult> = Array.isArray(
        args.preFixResults,
      )
        ? Object.fromEntries(
            (args.preFixResults as ActualResult[]).map((r) => [
              r.propertyId,
              r,
            ]),
          )
        : (args.preFixResults as Record<string, ActualResult>);

      const request: ApplyFixesAndReexecuteRequest = {
        targetRepoRef: args.targetRepoRef,
        applications: args.applications,
        properties,
        preFixResults,
      };

      const result = await applyFixesAndReexecute(request, {
        ...options.applyFixesAndReexecute,
        specRoot,
      });

      return finalizeToolResult(
        "apply_fixes_and_reexecute",
        result,
        specRoot,
        options,
      );
    },
  );

  server.registerTool(
    "lock_prediction",
    {
      title: "Lock a Predicted_Result before execution begins",
      description:
        "Lock the read-only Predicted_Result for a Correctness_Property BEFORE " +
        "any execution. Computes a content hash (SHA-256) + timestamp over the " +
        "Predicted_Result and the Correctness_Property test file it refers to and " +
        "persists a Prediction_Lock on disk, so the prediction cannot silently " +
        "change once execution starts (R3.4, R3.5). The Kiro_Power MUST call this " +
        "for every prediction before execute_properties; later comparison reads " +
        "the LOCKED verdict, never an edited one. Returns the persisted lock on " +
        "success, or a structured issue (missing/invalid prediction, missing " +
        "property file) when no lock could be written.",
      inputSchema: lockPredictionInputShape,
    },
    async (args) => {
      const target: LockTarget = {
        specRoot: args.specRoot,
        claimId: args.claimId,
        propertyNumber: args.propertyNumber,
      };

      const result = await lockPrediction(target, options.lockPrediction);

      return {
        // LockResult is a plain serializable JSON object; the SDK types
        // structuredContent as an open record, so expose it as one.
        structuredContent: result as unknown as Record<string, unknown>,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.registerTool(
    "supersede_prediction_lock",
    {
      title: "Supersede a Prediction_Lock after a legitimate property-file edit",
      description:
        "Record an auditable SUPERSEDE of an active Prediction_Lock and re-lock " +
        "the EDITED Correctness_Property test file, KEEPING the predicted " +
        "verdict unchanged (R3.5). Use this ONLY when a property test file was " +
        "changed after locking to fix a harness defect — never the asserted " +
        "claim and never the prediction. It moves the previous lock verbatim " +
        "into locks/superseded/ under a timestamped name, writes a sibling note " +
        "recording the reason and the previous hashes, then re-locks the " +
        "current source with a fresh contentHash/propertyContentHash/timestamp. " +
        "If the Predicted_Result now records a different verdict than the locked " +
        "one, it REFUSES (structured issue) rather than changing the verdict. " +
        "execute_properties refuses to run a property whose source drifted from " +
        "its lock until a supersede is recorded.",
      inputSchema: supersedePredictionLockInputShape,
    },
    async (args) => {
      const target: LockTarget = {
        specRoot: args.specRoot,
        claimId: args.claimId,
        propertyNumber: args.propertyNumber,
      };

      const result = await supersedePredictionLock(target, {
        reason: args.reason,
        now: options.lockPrediction?.now,
      });

      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.registerTool(
    "compare_predictions",
    {
      title: "Compare LOCKED predictions against a persisted execution result",
      description:
        "Run the Comparison Engine against a persisted execution result " +
        "(what execute_properties / apply_fixes_and_reexecute wrote under " +
        "results/), reading each predicted verdict ONLY from the on-disk " +
        "Prediction_Locks — never from the caller — so comparison uses the " +
        "originally recorded value (R3.5). Classifies each property " +
        "(MATCH / PREDICTION_MISMATCH / NOT_COMPARED_TIMEOUT / NOT_EXECUTED) " +
        "and reports two distinct counts: lieCount = confirmed bugs (actual " +
        "FAIL) grouped by root cause (a confirmed bug is a lie even when its " +
        "prediction matched), and predictionMismatchCount = rows where the " +
        "locked predicted verdict differs from the actual one; confirmedBugCount " +
        "is the ungrouped number of confirmed bugs. When a rootCauses map is " +
        "given, symptom comparisons are grouped under their root cause and a lie " +
        "is counted once per root cause rather than once per symptom. " +
        "Writes <specRoot>/comparison.json and returns the summary plus the " +
        "written path.",
      inputSchema: comparePredictionsInputShape,
    },
    async (args) => {
      const request: ComparePredictionsRequest = {
        specRoot: args.specRoot,
        resultsPath: args.resultsPath,
        rootCauses: args.rootCauses,
      };

      let result;
      try {
        result = await comparePredictions(request);
      } catch (error) {
        return schemaErrorResult(
          "compare_predictions",
          `compare_predictions could not read the persisted result at ` +
            `"${args.resultsPath}": ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }

      // Persist this tool's own raw result verbatim under results/ too (change
      // 2), and return it annotated with that path alongside comparison.json.
      return finalizeToolResult(
        "compare_predictions",
        result,
        args.specRoot,
        options,
      );
    },
  );

  return server;
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the MCP_Server and connect it to the stdio transport so a local
 * Kiro_Power can launch it as a subprocess and speak MCP over stdin/stdout.
 * Resolves once the transport is connected; the process then stays alive
 * serving requests until the transport closes.
 */
export async function startStdioServer(
  options: CreateMcpServerOptions = {},
): Promise<McpServer> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
