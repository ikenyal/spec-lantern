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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type {
  ActualResult,
  PropertyExecutionResult,
} from "@spec-lantern/types";
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
  const server = createMcpServer({ execute: { runner } });
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
  const server = createMcpServer({ replay: { runner } });
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
