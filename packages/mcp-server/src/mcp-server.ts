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
 * SCOPE. `execute_properties` (task 10.1), `replay_counterexample`
 * (task 11.1), and `apply_fixes_and_reexecute` (task 15.2) are wired here, each
 * delegating to its pure orchestrator behind this same transport seam. The
 * `apply_fixes_and_reexecute` handler delegates to
 * {@link applyFixesAndReexecute}, which copies the Target_Repo, applies fixes to
 * the copy (task 15.1), and re-executes the properties against the copy via
 * {@link executeProperties}.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  SPEC_LANTERN,
  type ActualResult,
  type PropertyExecutionRequest,
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
  type LockPredictionOptions,
  type LockTarget,
} from "./prediction-lock/index.js";

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
  /** Path / copy reference the runner mounts (never executed on the host). */
  targetRepoRef: z.string(),
  /** The Correctness_Properties to execute. */
  properties: z.array(correctnessPropertySchema),
  /** Which pipeline phase this execution belongs to. */
  phase: z.enum(["initial", "post_fix"]),
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
  /** The SAME Correctness_Properties to re-execute against the fixed copy. */
  properties: z.array(correctnessPropertySchema),
  /** Pre_Fix_Result per propertyId — the original execution outcome (R8.4). */
  preFixResults: z.record(z.string(), actualResultSchema),
} as const;

/**
 * Zod shape for the `replay_counterexample` tool input (design tool table:
 * `{ property, executionContext }`, plus the `targetRepoRef` the runner mounts).
 * Declared as a raw shape so each field is a named tool argument, matching the
 * `execute_properties` convention.
 */
const replayCounterexampleInputShape = {
  /** Path / copy reference the runner mounts (never executed on the host). */
  targetRepoRef: z.string(),
  /** The single Correctness_Property to replay. */
  property: correctnessPropertySchema,
  /** The Execution_Context recorded with the original Counterexample (R6.2). */
  executionContext: executionContextSchema,
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
      const request: PropertyExecutionRequest = {
        targetRepoRef: args.targetRepoRef,
        properties: args.properties,
        phase: args.phase,
      };

      const result = await executeProperties(request, options.execute);

      return {
        // PropertyExecutionResult is a plain serializable JSON object; the SDK
        // types structuredContent as an open record, so expose it as one.
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
      const request: ReplayCounterexampleRequest = {
        targetRepoRef: args.targetRepoRef,
        property: args.property,
        executionContext: args.executionContext,
      };

      const result = await replayCounterexample(request, options.replay);

      return {
        // ActualResult is a plain serializable JSON object; the SDK types
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
      const request: ApplyFixesAndReexecuteRequest = {
        targetRepoRef: args.targetRepoRef,
        applications: args.applications,
        properties: args.properties,
        // The zod record validates each value as a closed ActualResult; narrow
        // back to the typed record for the orchestrator.
        preFixResults: args.preFixResults as Record<string, ActualResult>,
      };

      const result = await applyFixesAndReexecute(
        request,
        options.applyFixesAndReexecute,
      );

      return {
        // The result is a plain serializable JSON object; the SDK types
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
