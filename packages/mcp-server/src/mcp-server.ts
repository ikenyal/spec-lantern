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
 * SCOPE (task 10.1). Only `execute_properties`, its transport wiring, and the
 * normal VERDICT path are wired here. The `apply_fixes_and_reexecute` (task 15)
 * and `replay_counterexample` (task 11) tools, plus the richer
 * Counterexample/timeout/execution-error surfacing (task 10.2) and
 * Execution_Context recording (task 10.3), are follow-on tasks that register
 * additional tools / enrich the orchestrator behind this same seam.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SPEC_LANTERN, type PropertyExecutionRequest } from "@spec-lantern/types";
import {
  executeProperties,
  type ExecutePropertiesOptions,
} from "./orchestrator/index.js";

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

/* -------------------------------------------------------------------------- */
/* Server construction                                                        */
/* -------------------------------------------------------------------------- */

/** Options for {@link createMcpServer}, forwarded to the orchestrator. */
export interface CreateMcpServerOptions {
  /** Orchestration overrides (runner, timeout, log) for `execute_properties`. */
  execute?: ExecutePropertiesOptions;
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
