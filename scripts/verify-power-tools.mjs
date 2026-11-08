#!/usr/bin/env node
/**
 * verify-power-tools.mjs — local verification WITHOUT GitHub (task step 2).
 *
 * Spawns the BUNDLED server (out/spec-lantern-power/dist/server.mjs) exactly as
 * the published Power would (node over stdio), performs the MCP handshake, and
 * lists its tools. This is a pure protocol check: it does the initialize +
 * tools/list round-trip and NEVER calls a tool, so no target code runs. The
 * server must report all four tools.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(
  here,
  "..",
  "out",
  "spec-lantern-power",
  "dist",
  "server.mjs",
);

const EXPECTED = [
  "lock_prediction",
  "execute_properties",
  "replay_counterexample",
  "apply_fixes_and_reexecute",
].sort();

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [serverPath],
  });
  const client = new Client(
    { name: "verify-power-tools", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  await client.close();

  process.stdout.write(`tools reported: ${JSON.stringify(names)}\n`);

  const missing = EXPECTED.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !EXPECTED.includes(n));
  if (missing.length || extra.length) {
    process.stdout.write(
      `FAIL — missing: ${JSON.stringify(missing)} extra: ${JSON.stringify(extra)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("OK — all 4 tools present over stdio from the bundle\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`verify-power-tools FAILED: ${message}\n`);
  process.exitCode = 1;
});
