// Feature: spec-lantern — Revive loop re-execute-after-fix tests (task 15.2).
//
// These cover the two responsibilities of task 15.2 (R8.3–R8.7):
//   1. The PURE transition classifier `classifyTransition` maps every (pre,
//      post) verdict pair to the exact classification: FAIL→PASS = FIXED,
//      FAIL→FAIL = NOT_RESOLVED, PASS→FAIL = REGRESSION, PASS→PASS = STILL_PASSING.
//   2. The orchestrator `applyFixesAndReexecute` copies the Target_Repo, applies
//      fixes to the COPY (reusing 15.1), re-executes the SAME properties against
//      the copy (phase post_fix) through a FAKE Isolated_Runner, and pairs the
//      caller-supplied Pre_Fix_Result with the fresh Post_Fix_Result into a
//      Property_Transition — plus the end-to-end FIXED, REGRESSION, and
//      NOT_RESOLVED flows and the non-verdict "skipped" (no fabricated
//      transition) path.
//
// A FAKE IsolatedRunner injected via options.execute.runner drives the post-fix
// execution deterministically — no Podman/container needed. The byte-for-byte
// "original is untouched" guarantee is fully covered by 15.1's suite
// (apply-fixes.test.ts); here we only lightly re-assert the original is present
// and unchanged so the re-execution flow's reliance on 15.1 is visible.

import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActualResult,
  CorrectnessProperty,
  FixTask,
  Verdict,
} from "@spec-lantern/types";
import type {
  IsolatedRunner,
  IsolatedRunnerRequest,
} from "../runner/isolated-runner.js";
import type { FixApplication } from "./apply-fixes.js";
import {
  applyFixesAndReexecute,
  classifyTransition,
} from "./apply-fixes-reexecute.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Minimal valid Correctness_Property for a function-kind claim. */
function makeProperty(id: string): CorrectnessProperty {
  return {
    id,
    claimId: id.replace(/^property-\d+\./, ""),
    title: `property ${id}`,
    statement: "for all inputs, the behavior holds",
    kind: "function",
    validatesRequirements: ["8.3"],
  };
}

/** A VERDICT ActualResult for a property. */
function verdict(propertyId: string, v: Verdict): ActualResult {
  return { propertyId, outcome: "VERDICT", verdict: v };
}

/** A well-formed Fix_Task (appliesTo pinned to the copy). */
function fixTask(id: string, confirmedBugPropertyId = "property-1"): FixTask {
  return {
    id,
    confirmedBugPropertyId,
    description: `fix for ${confirmedBugPropertyId}`,
    appliesTo: "Target_Repo_Copy",
  };
}

/**
 * A fake Isolated_Runner that records every request and returns a scripted
 * ActualResult per propertyId (defaulting to PASS). This is the POST-fix run's
 * runner — injected via options.execute.runner — so the post-fix verdicts are
 * fully under the test's control and no container is needed. `calls` lets a test
 * assert the re-execution targeted the COPY path.
 */
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

/** sha256 fingerprint of every file under `root`, keyed by repo-relative path. */
async function hashTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const bytes = await readFile(abs);
        const rel = relative(root, abs).split(sep).join("/");
        out.set(rel, createHash("sha256").update(bytes).digest("hex"));
      }
    }
  }
  await walk(root);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Pure transition classification (R8.5–R8.7)                                 */
/* -------------------------------------------------------------------------- */

describe("classifyTransition — the pure decision table (R8.5–R8.7)", () => {
  it("FAIL → PASS = FIXED", () => {
    expect(classifyTransition("FAIL", "PASS", "p")).toEqual({
      propertyId: "p",
      preFixResult: "FAIL",
      postFixResult: "PASS",
      classification: "FIXED",
    });
  });

  it("FAIL → FAIL = NOT_RESOLVED (R8.6)", () => {
    expect(classifyTransition("FAIL", "FAIL", "p")).toEqual({
      propertyId: "p",
      preFixResult: "FAIL",
      postFixResult: "FAIL",
      classification: "NOT_RESOLVED",
    });
  });

  it("PASS → FAIL = REGRESSION (R8.7)", () => {
    expect(classifyTransition("PASS", "FAIL", "p")).toEqual({
      propertyId: "p",
      preFixResult: "PASS",
      postFixResult: "FAIL",
      classification: "REGRESSION",
    });
  });

  it("PASS → PASS = STILL_PASSING", () => {
    expect(classifyTransition("PASS", "PASS", "p")).toEqual({
      propertyId: "p",
      preFixResult: "PASS",
      postFixResult: "PASS",
      classification: "STILL_PASSING",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Orchestrator: copy → apply → re-execute → pair (R8.3, R8.4)                */
/* -------------------------------------------------------------------------- */

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

describe("applyFixesAndReexecute — copy, re-execute, pair (R8.3, R8.4)", () => {
  it("re-executes the SAME properties against the COPY (phase post_fix) and reports a FIXED transition", async () => {
    const property = makeProperty("property-1.claim-a");

    // Pre-fix: the original execution FAILed (the Confirmed_Bug).
    const preFixResults: Record<string, ActualResult> = {
      "property-1.claim-a": verdict("property-1.claim-a", "FAIL"),
    };

    // Post-fix: the fake runner reports PASS against the fixed copy.
    const runner = fakeRunner({
      "property-1.claim-a": verdict("property-1.claim-a", "PASS"),
    });

    const applications: FixApplication[] = [
      {
        fixTask: fixTask("fix-1", "property-1.claim-a"),
        edits: [
          {
            kind: "write",
            path: "src/order.ts",
            contents:
              "export const reverse = false; // fixed: current month first\n",
          },
        ],
      },
    ];

    const result = await applyFixesAndReexecute(
      {
        targetRepoRef: originalRepo,
        applications,
        properties: [property],
        preFixResults,
      },
      {
        execute: { runner },
        apply: { copyParentDir: copyParent },
        // Keep the copy so we can assert the fix landed in it and that the
        // re-execution targeted it.
        keepCopy: true,
      },
    );

    // The transition is FIXED (FAIL → PASS).
    expect(result.transitions).toEqual([
      {
        propertyId: "property-1.claim-a",
        preFixResult: "FAIL",
        postFixResult: "PASS",
        classification: "FIXED",
      },
    ]);
    expect(result.skippedPropertyIds).toEqual([]);

    // The per-property outcome pairs the recorded Pre with the fresh Post.
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      propertyId: "property-1.claim-a",
      preFixResult: { outcome: "VERDICT", verdict: "FAIL" },
      postFixResult: { outcome: "VERDICT", verdict: "PASS" },
      transition: { classification: "FIXED" },
    });

    // The post-fix execution result is carried through (R8.3/R8.4 post side).
    expect(result.postFixExecution.results).toEqual([
      verdict("property-1.claim-a", "PASS"),
    ]);

    // Traceability: the applied Fix_Task id is recorded.
    expect(result.appliedFixTaskIds).toEqual(["fix-1"]);

    // The re-execution dispatched the property against the COPY path (NOT the
    // original), with phase post_fix threaded through the request.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.targetRepoPath).toBe(result.targetRepoCopyPath);
    expect(result.targetRepoCopyPath).not.toBe(originalRepo);

    // The fix genuinely landed in the copy (sanity: re-execution ran fixed code).
    const orderCopy = await readFile(
      join(result.targetRepoCopyPath, "src", "order.ts"),
      "utf8",
    );
    expect(orderCopy).toContain("reverse = false");

    // Lightly re-assert (fully covered by 15.1): the ORIGINAL is unchanged.
    const orderOriginal = await readFile(
      join(originalRepo, "src", "order.ts"),
      "utf8",
    );
    expect(orderOriginal).toContain("reverse = true");

    await rm(result.targetRepoCopyPath, { recursive: true, force: true });
  });

  it("reports a REGRESSION when a passing property breaks after the fix (PASS → FAIL, R8.7)", async () => {
    const property = makeProperty("property-2.claim-b");
    const preFixResults: Record<string, ActualResult> = {
      "property-2.claim-b": verdict("property-2.claim-b", "PASS"),
    };
    const runner = fakeRunner({
      "property-2.claim-b": verdict("property-2.claim-b", "FAIL"),
    });

    const result = await applyFixesAndReexecute(
      {
        targetRepoRef: originalRepo,
        applications: [
          {
            fixTask: fixTask("fix-r", "property-1.other"),
            edits: [
              { kind: "write", path: "src/order.ts", contents: "broken\n" },
            ],
          },
        ],
        properties: [property],
        preFixResults,
      },
      { execute: { runner }, apply: { copyParentDir: copyParent } },
    );

    expect(result.transitions).toEqual([
      {
        propertyId: "property-2.claim-b",
        preFixResult: "PASS",
        postFixResult: "FAIL",
        classification: "REGRESSION",
      },
    ]);
  });

  it("reports NOT_RESOLVED when the fix fails to fix it (FAIL → FAIL, R8.6)", async () => {
    const property = makeProperty("property-3.claim-c");
    const preFixResults: Record<string, ActualResult> = {
      "property-3.claim-c": verdict("property-3.claim-c", "FAIL"),
    };
    const runner = fakeRunner({
      "property-3.claim-c": verdict("property-3.claim-c", "FAIL"),
    });

    const result = await applyFixesAndReexecute(
      {
        targetRepoRef: originalRepo,
        applications: [
          {
            fixTask: fixTask("fix-n", "property-3.claim-c"),
            edits: [
              {
                kind: "write",
                path: "src/order.ts",
                contents: "// ineffective fix\n",
              },
            ],
          },
        ],
        properties: [property],
        preFixResults,
      },
      { execute: { runner }, apply: { copyParentDir: copyParent } },
    );

    expect(result.transitions).toEqual([
      {
        propertyId: "property-3.claim-c",
        preFixResult: "FAIL",
        postFixResult: "FAIL",
        classification: "NOT_RESOLVED",
      },
    ]);
  });

  it("builds NO transition when a side is a non-verdict outcome (skipped, not fabricated)", async () => {
    const withPre = makeProperty("property-1.has-pre");
    const noPre = makeProperty("property-2.no-pre");

    // property-1 has a FAIL pre-fix, but the post-fix run TIMES OUT → no pair.
    // property-2 has no pre-fix result recorded at all → no pair.
    const preFixResults: Record<string, ActualResult> = {
      "property-1.has-pre": verdict("property-1.has-pre", "FAIL"),
    };
    const runner = fakeRunner({
      "property-1.has-pre": {
        propertyId: "property-1.has-pre",
        outcome: "TIMEOUT",
        limitSeconds: 30,
      },
      "property-2.no-pre": verdict("property-2.no-pre", "PASS"),
    });

    const result = await applyFixesAndReexecute(
      {
        targetRepoRef: originalRepo,
        applications: [
          {
            fixTask: fixTask("fix-skip", "property-1.has-pre"),
            edits: [{ kind: "write", path: "src/order.ts", contents: "x\n" }],
          },
        ],
        properties: [withPre, noPre],
        preFixResults,
      },
      { execute: { runner }, apply: { copyParentDir: copyParent } },
    );

    // No fabricated transitions — both properties are skipped.
    expect(result.transitions).toEqual([]);
    expect(result.skippedPropertyIds.sort()).toEqual([
      "property-1.has-pre",
      "property-2.no-pre",
    ]);

    // The outcomes still carry both sides for the report, just without a
    // transition.
    const byId = new Map(result.outcomes.map((o) => [o.propertyId, o]));
    expect(byId.get("property-1.has-pre")?.transition).toBeUndefined();
    expect(byId.get("property-1.has-pre")?.postFixResult?.outcome).toBe(
      "TIMEOUT",
    );
    expect(byId.get("property-2.no-pre")?.transition).toBeUndefined();
    expect(byId.get("property-2.no-pre")?.preFixResult).toBeUndefined();
  });

  it("cleans up the Target_Repo_Copy by default (keepCopy unset)", async () => {
    const property = makeProperty("property-1.claim-a");
    const runner = fakeRunner();

    const result = await applyFixesAndReexecute(
      {
        targetRepoRef: originalRepo,
        applications: [
          {
            fixTask: fixTask("fix-1", "property-1.claim-a"),
            edits: [{ kind: "write", path: "src/order.ts", contents: "x\n" }],
          },
        ],
        properties: [property],
        preFixResults: {
          "property-1.claim-a": verdict("property-1.claim-a", "FAIL"),
        },
      },
      { execute: { runner }, apply: { copyParentDir: copyParent } },
    );

    // The copy directory was removed after re-execution (throwaway artifact).
    await expect(readdir(result.targetRepoCopyPath)).rejects.toThrow();

    // And the original survives untouched.
    const original = await hashTree(originalRepo);
    expect(original.has("src/order.ts")).toBe(true);
  });
});
