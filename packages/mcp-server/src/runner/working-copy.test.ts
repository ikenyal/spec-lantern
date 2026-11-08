// Feature: spec-lantern — the Target_Repo is READ-ONLY (critical safety fix)
//
// The product's central promise — stated on the site and in steering 00 — is
// that the Target_Repo is read-only: analyzing an app must never mutate the
// user's own repo. An end-to-end trial of the packaged Power found that
// `execute_properties` and `replay_counterexample` mounted the ORIGINAL repo in
// place, so the install phase wrote `node_modules` and rewrote
// `package.json` / `package-lock.json` INTO the user's repo. The fix copies the
// target into a fresh throwaway working copy and mounts THAT; the original is
// never mounted.
//
// These tests PROVE the guarantee the way the safety fix requires: fingerprint
// every file in the original target (contents + the ABSENCE of node_modules and
// lock files) BEFORE and AFTER each of the three tools, and assert the
// fingerprint is byte-for-byte unchanged. A FAKE IsolatedRunner stands in for
// Podman — but crucially it also SIMULATES the install-phase side effect by
// writing `node_modules` + a lock file INTO whatever directory it is handed. So
// if any tool mounted the original, that write would land in the original and
// the fingerprint would change, failing the test. Because the tools mount a
// throwaway COPY, the writes land in the copy (which is then removed) and the
// original stays pristine. The real container is exercised once by the opt-in
// Podman smoke test (dispatch-topology.smoke.test.ts); these cover the
// copy/cleanup wrapping deterministically and offline.

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActualResult,
  CorrectnessProperty,
  ExecutionContext,
  PropertyExecutionRequest,
} from "@spec-lantern/types";
import type {
  IsolatedRunner,
  IsolatedRunnerRequest,
} from "./isolated-runner.js";
import { executeProperties } from "../orchestrator/index.js";
import { replayCounterexample } from "../orchestrator/replay.js";
import { applyFixesAndReexecute } from "../revive/apply-fixes-reexecute.js";

/* -------------------------------------------------------------------------- */
/* Fingerprinting the original target                                         */
/* -------------------------------------------------------------------------- */

/**
 * A content fingerprint of a directory tree: a sorted map of repo-relative POSIX
 * path → SHA-256 of the file's bytes (directories recorded as a marker). Two
 * trees with the same fingerprint are byte-for-byte identical in structure and
 * content — exactly what "the original is read-only" means.
 */
async function fingerprint(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (entry.isDirectory()) {
        out[`${rel}/`] = "<dir>";
        await walk(abs);
      } else {
        const bytes = await readFile(abs);
        out[rel] = createHash("sha256").update(bytes).digest("hex");
      }
    }
  }
  await walk(root);
  return out;
}

/* -------------------------------------------------------------------------- */
/* A fake runner that SIMULATES the install-phase mutation                    */
/* -------------------------------------------------------------------------- */

/**
 * A fake Isolated_Runner that returns a scripted verdict AND — like the real
 * install phase — writes `node_modules/` + rewrites `package-lock.json` INTO
 * the directory it is handed (`request.targetRepoPath`). This is the whole point
 * of these tests: if a tool mounts the ORIGINAL, these writes mutate the
 * original and the fingerprint assertion fails; mounting a throwaway copy keeps
 * the original pristine.
 */
function installSimulatingRunner(
  scripted: Record<string, ActualResult> = {},
): IsolatedRunner & { calls: IsolatedRunnerRequest[] } {
  const calls: IsolatedRunnerRequest[] = [];
  async function simulateInstall(mountPath: string): Promise<void> {
    await mkdir(join(mountPath, "node_modules", "left-pad"), {
      recursive: true,
    });
    await writeFile(
      join(mountPath, "node_modules", "left-pad", "index.js"),
      "module.exports = () => {};\n",
    );
    // Rewrite the lock file the way `npm install` would.
    await writeFile(
      join(mountPath, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, name: "mutated" }),
    );
    // Touch package.json the way a dependency add would.
    await writeFile(
      join(mountPath, "package.json"),
      JSON.stringify({ name: "mutated-by-install", version: "9.9.9" }),
    );
  }
  return {
    calls,
    async runProperty(request: IsolatedRunnerRequest): Promise<ActualResult> {
      calls.push(request);
      await simulateInstall(request.targetRepoPath);
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

/* -------------------------------------------------------------------------- */
/* A realistic original Target_Repo on disk                                   */
/* -------------------------------------------------------------------------- */

function makeProperty(id: string): CorrectnessProperty {
  return {
    id,
    claimId: id.replace(/^property-\d+\./, ""),
    title: `property ${id}`,
    statement: "for all inputs, the behavior holds",
    kind: "function",
    validatesRequirements: ["5.1"],
  };
}

const RECORDED_CONTEXT: ExecutionContext = {
  randomSeed: 123,
  timezone: "Asia/Tokyo",
  fixedCurrentTime: "2020-01-15T00:00:00.000Z",
};

describe("Target_Repo is read-only across every executing tool (safety fix)", () => {
  let original: string;
  let specRoot: string;

  beforeEach(async () => {
    // A realistic original repo: package.json, a lock file, and source — but NO
    // node_modules (the user cloned it but never installed). The "no
    // node_modules" state is itself part of what must be preserved.
    original = await mkdtemp(join(tmpdir(), "spec-lantern-readonly-orig-"));
    await writeFile(
      join(original, "package.json"),
      JSON.stringify({ name: "target", version: "1.0.0" }, null, 2) + "\n",
    );
    await writeFile(
      join(original, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, name: "target" }, null, 2) + "\n",
    );
    await mkdir(join(original, "src"), { recursive: true });
    await writeFile(
      join(original, "src", "order.ts"),
      "export const reverse = true;\n",
    );

    // A spec root the tool stages property files from (so the caller need not
    // place them inside the copy by hand).
    specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-readonly-spec-"));
    await mkdir(join(specRoot, "properties"), { recursive: true });
    await writeFile(
      join(specRoot, "properties", "property-1.claim-a.test.ts"),
      "// Feature: spec-lantern, Property 1\nexport {};\n",
    );
  });

  afterEach(async () => {
    await rm(original, { recursive: true, force: true });
    await rm(specRoot, { recursive: true, force: true });
  });

  it("execute_properties leaves the original byte-for-byte unchanged (no node_modules, lock intact)", async () => {
    const before = await fingerprint(original);
    const runner = installSimulatingRunner();

    const request: PropertyExecutionRequest = {
      targetRepoRef: original,
      properties: [makeProperty("property-1.claim-a")],
      phase: "initial",
    };
    const result = await executeProperties(request, { runner, specRoot });

    // The run produced a verdict (the fake ran), and it ran against a COPY — not
    // the original (the mounted path differs from the original).
    expect(result.results[0]?.outcome).toBe("VERDICT");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.targetRepoPath).not.toBe(original);

    // The install-phase mutation the fake performed did NOT touch the original.
    const after = await fingerprint(original);
    expect(after).toEqual(before);
    // Explicitly: no node_modules leaked into the original.
    await expect(stat(join(original, "node_modules"))).rejects.toThrow();
    // And the lock file + package.json are the originals, not the rewritten ones.
    expect(JSON.parse(await readFile(join(original, "package-lock.json"), "utf8")).name).toBe("target");
    expect(JSON.parse(await readFile(join(original, "package.json"), "utf8")).name).toBe("target");
  });

  it("replay_counterexample leaves the original byte-for-byte unchanged", async () => {
    const before = await fingerprint(original);
    const runner = installSimulatingRunner({
      "property-1.claim-a": {
        propertyId: "property-1.claim-a",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample: {
          propertyId: "property-1.claim-a",
          input: { now: "Jan 2020" },
          observedOutput: "Aug 2019",
          executionContext: RECORDED_CONTEXT,
        },
      },
    });

    const result = await replayCounterexample(
      {
        targetRepoRef: original,
        property: makeProperty("property-1.claim-a"),
        executionContext: RECORDED_CONTEXT,
      },
      { runner, specRoot },
    );

    expect(result.outcome).toBe("VERDICT");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.targetRepoPath).not.toBe(original);

    const after = await fingerprint(original);
    expect(after).toEqual(before);
    await expect(stat(join(original, "node_modules"))).rejects.toThrow();
  });

  it("apply_fixes_and_reexecute leaves the original byte-for-byte unchanged", async () => {
    const before = await fingerprint(original);
    // Post-fix: the fake reports PASS (and still simulates the install mutation
    // into the copy it is handed).
    const runner = installSimulatingRunner({
      "property-1.claim-a": {
        propertyId: "property-1.claim-a",
        outcome: "VERDICT",
        verdict: "PASS",
      },
    });

    const result = await applyFixesAndReexecute(
      {
        targetRepoRef: original,
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
        properties: [makeProperty("property-1.claim-a")],
        preFixResults: {
          "property-1.claim-a": {
            propertyId: "property-1.claim-a",
            outcome: "VERDICT",
            verdict: "FAIL",
          },
        },
      },
      { execute: { runner }, specRoot },
    );

    // The fix landed on the COPY and the transition classified FIXED.
    expect(result.transitions[0]?.classification).toBe("FIXED");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.targetRepoPath).toBe(result.targetRepoCopyPath);
    expect(result.targetRepoCopyPath).not.toBe(original);

    // The original is untouched: the fix edit, the install mutation, and the
    // staged property file all landed only on the throwaway copy.
    const after = await fingerprint(original);
    expect(after).toEqual(before);
    await expect(stat(join(original, "node_modules"))).rejects.toThrow();
    // The fix did NOT rewrite the original source.
    expect(await readFile(join(original, "src", "order.ts"), "utf8")).toContain(
      "reverse = true",
    );
  });

  it("removes the throwaway working copy after execute_properties (no leak)", async () => {
    const runner = installSimulatingRunner();
    const request: PropertyExecutionRequest = {
      targetRepoRef: original,
      properties: [makeProperty("property-1.claim-a")],
      phase: "initial",
    };
    await executeProperties(request, { runner, specRoot });

    // The copy the runner was handed must have been cleaned up in the finally.
    const mounted = runner.calls[0]?.targetRepoPath;
    expect(mounted).toBeDefined();
    await expect(stat(mounted!)).rejects.toThrow();
  });
});
