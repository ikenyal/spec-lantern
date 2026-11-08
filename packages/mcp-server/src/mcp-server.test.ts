// Feature: spec-lantern — MCP transport + execute_properties tool wiring (task 10.1)
//
// Round-trips the `execute_properties` tool over an in-memory MCP transport
// pair (SDK Client ↔ Server, no stdio/subprocess) to prove the tool is exposed
// via the MCP TypeScript SDK and that a call flows request → Safety Gate →
// runner → response:
//   - an accepted request returns a VERDICT per property (R5.1, R5.5);
//   - a host-bound request is rejected as SAFETY_VIOLATION and the injected
//     runner is NEVER used (R5.2, R12.1, R12.4);
//   - the result is carried as structuredContent AND as a JSON text block.
//
// A FAKE IsolatedRunner is injected through createMcpServer so the tool handler
// is exercised deterministically without Podman.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActualResult,
  PropertyExecutionResult,
} from "@spec-lantern/types";
import type { ApplyFixesAndReexecuteResult } from "./revive/apply-fixes-reexecute.js";
import type {
  IsolatedRunner,
  IsolatedRunnerRequest,
} from "./runner/isolated-runner.js";
import { createMcpServer } from "./mcp-server.js";

function fakeRunner(
  scripted: Record<string, ActualResult> = {},
): IsolatedRunner & { calls: IsolatedRunnerRequest[] } {
  const calls: IsolatedRunnerRequest[] = [];
  return {
    calls,
    async runProperty(request: IsolatedRunnerRequest): Promise<ActualResult> {
      calls.push(request);
      return (
        scripted[request.propertyId] ?? {
          propertyId: request.propertyId,
          outcome: "VERDICT",
          verdict: "PASS",
        }
      );
    },
  };
}

/** Connect an SDK Client to a freshly built server over an in-memory pair. */
async function connectClient(
  runner: IsolatedRunner,
): Promise<{ client: Client; close: () => Promise<void> }> {
  // mountInPlace: true exercises the transport → gate → runner wiring with a
  // symbolic target ref (no real copy). The copy-safety behavior — an external
  // tool call copies the original into a throwaway and mounts THAT — is covered
  // against a real on-disk repo in working-copy.test.ts.
  const server = createMcpServer({ execute: { runner, mountInPlace: true } });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("execute_properties MCP tool (task 10.1)", () => {
  it("is listed as an available tool", async () => {
    const runner = fakeRunner();
    const { client, close } = await connectClient(runner);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("execute_properties");
    } finally {
      await close();
    }
  });

  it("runs an accepted request through the runner and returns VERDICTs", async () => {
    const runner = fakeRunner({
      "property-1.claim-a": {
        propertyId: "property-1.claim-a",
        outcome: "VERDICT",
        verdict: "FAIL",
      },
    });
    const { client, close } = await connectClient(runner);
    try {
      const res = await client.callTool({
        name: "execute_properties",
        arguments: {
          targetRepoRef: "target-repo-copy-abc",
          properties: [
            {
              id: "property-1.claim-a",
              claimId: "claim-a",
              title: "p",
              statement: "for all x, holds",
              kind: "function",
              validatesRequirements: ["5.1"],
            },
          ],
          phase: "initial",
        },
      });

      const structured = res.structuredContent as PropertyExecutionResult;
      expect(structured.results).toEqual([
        { propertyId: "property-1.claim-a", outcome: "VERDICT", verdict: "FAIL" },
      ]);

      // The runner was actually dispatched to (through the handler → orchestrator).
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.targetRepoPath).toBe("target-repo-copy-abc");

      // The result is also available as a JSON text block.
      const textBlock = (res.content as { type: string; text: string }[]).find(
        (c) => c.type === "text",
      );
      expect(textBlock).toBeDefined();
      const parsed = JSON.parse(textBlock!.text) as PropertyExecutionResult;
      expect(parsed.results[0]?.outcome).toBe("VERDICT");
    } finally {
      await close();
    }
  });

  it("rejects a host-bound request as SAFETY_VIOLATION without using the runner", async () => {
    const runner = fakeRunner();
    const { client, close } = await connectClient(runner);
    try {
      const res = await client.callTool({
        name: "execute_properties",
        arguments: {
          targetRepoRef: "host:/Users/me/project",
          properties: [
            {
              id: "property-1.claim-a",
              claimId: "claim-a",
              title: "p",
              statement: "for all x, holds",
              kind: "function",
              validatesRequirements: ["5.1"],
            },
          ],
          phase: "initial",
        },
      });

      const structured = res.structuredContent as PropertyExecutionResult;
      expect(structured.results[0]?.outcome).toBe("SAFETY_VIOLATION");
      // Gate rejected before dispatch — runner untouched.
      expect(runner.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("rejects an invalid request shape (schema validation) at the boundary", async () => {
    const runner = fakeRunner();
    const { client, close } = await connectClient(runner);
    try {
      const res = await client.callTool({
        name: "execute_properties",
        arguments: {
          // missing required `properties` and `phase`
          targetRepoRef: "target-repo-copy-abc",
        },
      });
      // The SDK validates against the input schema and returns a tool error
      // (isError) rather than reaching the handler — so the runner is untouched.
      expect(res.isError).toBe(true);
      expect(runner.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

// Feature: spec-lantern — MCP transport + replay_counterexample tool wiring (task 11.1)
//
// Round-trips the `replay_counterexample` tool over the same in-memory MCP
// transport pair to prove the tool is exposed and that a call flows request →
// Safety Gate → runner with the recorded Execution_Context FORCED through to the
// runner (R6.3). A FAKE IsolatedRunner is injected (via createMcpServer's
// `replay` options) so the handler is exercised deterministically without
// Podman.

/** Connect an SDK Client to a server whose REPLAY path uses the fake runner. */
async function connectReplayClient(
  runner: IsolatedRunner,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({ replay: { runner, mountInPlace: true } });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("replay_counterexample MCP tool (task 11.1)", () => {
  const recordedContext = {
    randomSeed: 123456789,
    timezone: "Asia/Tokyo",
    fixedCurrentTime: "2020-01-15T00:00:00.000Z",
  };

  it("is listed as an available tool", async () => {
    const runner = fakeRunner();
    const { client, close } = await connectReplayClient(runner);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("replay_counterexample");
    } finally {
      await close();
    }
  });

  it("replays through the runner with the recorded Execution_Context forced and returns the ActualResult", async () => {
    const counterexample = {
      propertyId: "property-1.claim-monthly-order",
      input: { now: "Jan 2020" },
      observedOutput: "Aug 2019",
      executionContext: recordedContext,
    };
    const runner = fakeRunner({
      "property-1.claim-monthly-order": {
        propertyId: "property-1.claim-monthly-order",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample,
      },
    });
    const { client, close } = await connectReplayClient(runner);
    try {
      const res = await client.callTool({
        name: "replay_counterexample",
        arguments: {
          targetRepoRef: "target-repo-copy-abc",
          property: {
            id: "property-1.claim-monthly-order",
            claimId: "claim-monthly-order",
            title: "p",
            statement: "for all x, holds",
            kind: "function",
            validatesRequirements: ["6.3"],
          },
          executionContext: recordedContext,
        },
      });

      const structured = res.structuredContent as ActualResult;
      expect(structured).toEqual({
        propertyId: "property-1.claim-monthly-order",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample,
      });

      // The runner was dispatched to with the recorded context FORCED (R6.3).
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.targetRepoPath).toBe("target-repo-copy-abc");
      expect(runner.calls[0]?.executionContext).toEqual(recordedContext);

      // Also surfaced as a JSON text block.
      const textBlock = (res.content as { type: string; text: string }[]).find(
        (c) => c.type === "text",
      );
      expect(textBlock).toBeDefined();
      const parsed = JSON.parse(textBlock!.text) as ActualResult;
      expect(parsed.outcome).toBe("VERDICT");
    } finally {
      await close();
    }
  });

  it("rejects a host-bound replay as SAFETY_VIOLATION without using the runner", async () => {
    const runner = fakeRunner();
    const { client, close } = await connectReplayClient(runner);
    try {
      const res = await client.callTool({
        name: "replay_counterexample",
        arguments: {
          targetRepoRef: "host:/Users/me/project",
          property: {
            id: "property-1.claim-monthly-order",
            claimId: "claim-monthly-order",
            title: "p",
            statement: "for all x, holds",
            kind: "function",
            validatesRequirements: ["6.3"],
          },
          executionContext: recordedContext,
        },
      });

      const structured = res.structuredContent as ActualResult;
      expect(structured.outcome).toBe("SAFETY_VIOLATION");
      expect(runner.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

// Feature: spec-lantern — MCP transport + apply_fixes_and_reexecute tool wiring (task 15.2)
//
// Round-trips the `apply_fixes_and_reexecute` tool over the same in-memory MCP
// transport pair to prove the tool is exposed and that a call flows request →
// copy+apply (15.1) → post-fix execution through the runner → Property_Transition.
// A FAKE IsolatedRunner is injected (via createMcpServer's
// `applyFixesAndReexecute` options) so the post-fix run is deterministic without
// Podman; a real throwaway on-disk Target_Repo backs the copy step.

/** Connect an SDK Client to a server whose REVIVE path uses the fake runner. */
async function connectReviveClient(
  runner: IsolatedRunner,
  copyParentDir: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({
    applyFixesAndReexecute: { execute: { runner }, apply: { copyParentDir } },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("apply_fixes_and_reexecute MCP tool (task 15.2)", () => {
  let originalRepo: string;
  let copyParent: string;

  beforeEach(async () => {
    originalRepo = await mkdtemp(join(tmpdir(), "spec-lantern-orig-"));
    copyParent = await mkdtemp(join(tmpdir(), "spec-lantern-copyparent-"));
    await writeFile(
      join(originalRepo, "package.json"),
      JSON.stringify({ name: "target", version: "1.0.0" }, null, 2),
    );
    await mkdir(join(originalRepo, "src"), { recursive: true });
    await writeFile(
      join(originalRepo, "src", "order.ts"),
      "export const reverse = true; // Reverse to have most recent month first\n",
    );
  });

  afterEach(async () => {
    await rm(originalRepo, { recursive: true, force: true });
    await rm(copyParent, { recursive: true, force: true });
  });

  it("is listed as an available tool", async () => {
    const runner = fakeRunner();
    const { client, close } = await connectReviveClient(runner, copyParent);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("apply_fixes_and_reexecute");
    } finally {
      await close();
    }
  });

  it("applies fixes to the copy, re-executes against it, and returns a FIXED transition", async () => {
    // Post-fix: the fake runner reports PASS against the fixed copy.
    const runner = fakeRunner({
      "property-1.claim-a": {
        propertyId: "property-1.claim-a",
        outcome: "VERDICT",
        verdict: "PASS",
      },
    });
    const { client, close } = await connectReviveClient(runner, copyParent);
    try {
      const res = await client.callTool({
        name: "apply_fixes_and_reexecute",
        arguments: {
          targetRepoRef: originalRepo,
          applications: [
            {
              fixTask: {
                id: "fix-1",
                confirmedBugPropertyId: "property-1.claim-a",
                description: "stop reversing",
                appliesTo: "Target_Repo_Copy",
              },
              edits: [
                {
                  kind: "write",
                  path: "src/order.ts",
                  contents: "export const reverse = false;\n",
                },
              ],
            },
          ],
          properties: [
            {
              id: "property-1.claim-a",
              claimId: "claim-a",
              title: "p",
              statement: "for all x, holds",
              kind: "function",
              validatesRequirements: ["8.3"],
            },
          ],
          // Pre_Fix_Result: the original FAILed (R8.4).
          preFixResults: {
            "property-1.claim-a": {
              propertyId: "property-1.claim-a",
              outcome: "VERDICT",
              verdict: "FAIL",
            },
          },
        },
      });

      const structured = res.structuredContent as ApplyFixesAndReexecuteResult;
      expect(structured.transitions).toEqual([
        {
          propertyId: "property-1.claim-a",
          preFixResult: "FAIL",
          postFixResult: "PASS",
          classification: "FIXED",
        },
      ]);
      expect(structured.appliedFixTaskIds).toEqual(["fix-1"]);

      // The runner was dispatched against the COPY (not the original).
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.targetRepoPath).toBe(structured.targetRepoCopyPath);
      expect(structured.targetRepoCopyPath).not.toBe(originalRepo);

      // The original survives untouched (lightly re-asserted; fully covered by 15.1).
      const original = await readFile(join(originalRepo, "src", "order.ts"), "utf8");
      expect(original).toContain("reverse = true");

      // Also surfaced as a JSON text block.
      const textBlock = (res.content as { type: string; text: string }[]).find(
        (c) => c.type === "text",
      );
      expect(textBlock).toBeDefined();
      const parsed = JSON.parse(textBlock!.text) as ApplyFixesAndReexecuteResult;
      expect(parsed.transitions[0]?.classification).toBe("FIXED");
    } finally {
      await close();
    }
  });
});

// Feature: spec-lantern — MCP transport + lock_prediction tool wiring (task 20, Stage A)
//
// Round-trips the `lock_prediction` tool over the same in-memory MCP transport
// pair to prove the prediction-lock responsibility (R3.4, R3.5) is reachable as
// an MCP tool — so a Kiro client can lock every Predicted_Result BEFORE calling
// execute_properties, exactly as 00-pipeline-and-safety.md requires. Backed by a
// real throwaway on-disk spec layout (claims/properties/predictions) so the lock
// is taken over genuine artifacts; no runner/Podman involved.

/** Connect an SDK Client to a server exposing lock_prediction. */
async function connectLockClient(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer({
    lockPrediction: { now: () => "2025-01-01T00:00:00.000Z" },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("lock_prediction MCP tool (task 20, Stage A)", () => {
  let specRoot: string;

  beforeEach(async () => {
    specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-spec-"));
    await mkdir(join(specRoot, "properties"), { recursive: true });
    await mkdir(join(specRoot, "predictions"), { recursive: true });
    await writeFile(
      join(specRoot, "properties", "property-1.claim-a.test.ts"),
      "// Feature: spec-lantern, Property 1\nexport {};\n",
    );
    await writeFile(
      join(specRoot, "predictions", "property-1.claim-a.predicted.json"),
      JSON.stringify(
        {
          propertyId: "property-1.claim-a",
          verdict: "PASS",
          recordedAt: "2025-01-01T00:00:00.000Z",
          immutable: true,
        },
        null,
        2,
      ),
    );
  });

  afterEach(async () => {
    await rm(specRoot, { recursive: true, force: true });
  });

  it("is listed as an available tool", async () => {
    const { client, close } = await connectLockClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("lock_prediction");
    } finally {
      await close();
    }
  });

  it("locks a Predicted_Result and returns the persisted lock", async () => {
    const { client, close } = await connectLockClient();
    try {
      const res = await client.callTool({
        name: "lock_prediction",
        arguments: { specRoot, claimId: "claim-a", propertyNumber: 1 },
      });
      const textBlock = (res.content as { type: string; text: string }[]).find(
        (c) => c.type === "text",
      );
      expect(textBlock).toBeDefined();
      const structured = JSON.parse(textBlock!.text) as {
        lock: { propertyId: string; verdict: string; contentHash: string } | null;
        issue: unknown;
      };
      expect(structured.issue).toBeNull();
      expect(structured.lock?.propertyId).toBe("property-1.claim-a");
      expect(structured.lock?.verdict).toBe("PASS");
      expect(structured.lock?.contentHash).toMatch(/^[0-9a-f]{64}$/);

      // The lock was persisted on disk.
      const persisted = await readFile(
        join(specRoot, "locks", "property-1.claim-a.lock.json"),
        "utf8",
      );
      expect(JSON.parse(persisted).verdict).toBe("PASS");
    } finally {
      await close();
    }
  });
});
