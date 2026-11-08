#!/usr/bin/env node
/**
 * Runnable stdio entry for the spec-lantern MCP_Server (task 20, Stage A).
 *
 * This is the thin executable the Kiro runtime launches as a subprocess and
 * speaks MCP over stdin/stdout. It builds and connects the server via
 * {@link startStdioServer}, which registers the five tools the Kiro_Power
 * drives:
 *   - `execute_properties`        (run Correctness_Properties in the runner)
 *   - `replay_counterexample`     (replay under a recorded Execution_Context)
 *   - `apply_fixes_and_reexecute` (Revive loop on the Target_Repo_Copy)
 *   - `lock_prediction`           (prediction lock over the on-disk artifacts)
 *   - `compare_predictions`       (locks vs a persisted execution result)
 *
 * The entry adds NO execution logic of its own. With no options it uses the
 * default MVP-scope Isolated_Runner (local rootless Podman, selected by
 * {@link getIsolatedRunner} inside the orchestrators), so the server never runs
 * Target_Repo code on the host.
 *
 * stdio hygiene: an MCP stdio server MUST keep stdout reserved for protocol
 * frames. Any diagnostics therefore go to stderr only.
 */
import { startStdioServer } from "../mcp-server.js";

async function main(): Promise<void> {
  await startStdioServer();
  // Connected. Keep the process alive; the SDK serves requests until the
  // transport (stdin) closes, at which point the process exits naturally.
  process.stderr.write("[spec-lantern] MCP server listening on stdio\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[spec-lantern] MCP server failed to start: ${message}\n`);
  process.exitCode = 1;
});
