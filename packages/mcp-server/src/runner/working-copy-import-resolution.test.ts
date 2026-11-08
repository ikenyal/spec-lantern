// Feature: spec-lantern — property imports resolve from the spec's real
// location inside the target (import-resolution fix)
//
// An end-to-end trial of the packaged Power found that `execute_properties`
// staged property files FLAT at `<copy>/properties/`, while a property imports
// the target RELATIVE to the property file's OWN location in the spec (e.g.
// `../../../src/utils` from `.spec-lantern/src-utils/properties/`). Flattened,
// those relative imports resolved to the wrong place and every property returned
// EXECUTION_ERROR.
//
// These tests pin the fix at two levels:
//  1. The pure containment helper `specRootRelInsideTarget` decides inside vs.
//     outside correctly (including the `..`-escape and equal-root edges).
//  2. End-to-end through `executeProperties` with a FAKE runner that captures
//     the `propertyTestFile` it is handed:
//       - spec root INSIDE the target → the property runs IN PLACE at
//         `<specRelToTarget>/properties/<id>.test.ts`, and a relative import
//         written in that file resolves to a REAL file in the copied target at
//         the depth the import assumes (no staging, nothing flattened);
//       - spec root OUTSIDE the target → the WHOLE spec is copied into the copy
//         at `.spec-lantern-spec/` and the property runs under that fixed path.
//
// A fake runner stands in for Podman: it records the request and reads the
// property file + resolves its relative import on the HOST copy it is handed, so
// a broken (flattened) path would surface here as a missing-file failure.

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActualResult,
  CorrectnessProperty,
  PropertyExecutionRequest,
} from "@spec-lantern/types";
import type {
  IsolatedRunner,
  IsolatedRunnerRequest,
} from "./isolated-runner.js";
import {
  EXTERNAL_SPEC_MOUNT_REL,
  specRootRelInsideTarget,
} from "./working-copy.js";
import { executeProperties } from "../orchestrator/index.js";

/* -------------------------------------------------------------------------- */
/* A fake runner that VERIFIES the property file + its relative import resolve */
/* -------------------------------------------------------------------------- */

/**
 * A fake Isolated_Runner that captures each request and, against the HOST copy
 * it was handed (`targetRepoPath`), asserts the `propertyTestFile`:
 *  - exists at the resolved in-mount path, and
 *  - its single `import ... from "<relative>"` line resolves to a file that
 *    exists in the copy.
 * If either check fails, the recorded outcome is EXECUTION_ERROR with the reason
 * — exactly the failure mode the flattening bug produced, so a regression fails
 * the test loudly. On success it returns a scripted/PASS verdict.
 */
function importCheckingRunner(): IsolatedRunner & {
  calls: IsolatedRunnerRequest[];
} {
  const calls: IsolatedRunnerRequest[] = [];
  return {
    calls,
    async runProperty(request: IsolatedRunnerRequest): Promise<ActualResult> {
      calls.push(request);
      const { targetRepoPath, propertyTestFile, propertyId } = request;
      const fileAbs = isAbsolute(propertyTestFile)
        ? propertyTestFile
        : resolve(targetRepoPath, propertyTestFile);
      let source: string;
      try {
        source = await readFile(fileAbs, "utf8");
      } catch {
        return {
          propertyId,
          outcome: "EXECUTION_ERROR",
          reason: `property test file not found at ${propertyTestFile}`,
        };
      }
      // Resolve a single relative import (if any) from the property's real
      // location, the way a bundler would.
      const match = source.match(/from\s+"(\.[^"]+)"/);
      if (match) {
        const importTarget = resolve(fileAbs, "..", match[1]);
        try {
          // Try the import as-is and with a .ts extension (bundler resolution).
          await access(importTarget).catch(() => access(`${importTarget}.ts`));
        } catch {
          return {
            propertyId,
            outcome: "EXECUTION_ERROR",
            reason: `relative import "${match[1]}" did not resolve from ${propertyTestFile}`,
          };
        }
      }
      return { propertyId, outcome: "VERDICT", verdict: "PASS" };
    },
  };
}

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

/* -------------------------------------------------------------------------- */
/* Pure helper                                                                */
/* -------------------------------------------------------------------------- */

describe("specRootRelInsideTarget (containment helper)", () => {
  it("returns the POSIX subpath when the spec root is inside the target", () => {
    expect(
      specRootRelInsideTarget("/a/target", "/a/target/.spec-lantern/src-utils"),
    ).toBe(".spec-lantern/src-utils");
  });

  it('returns "" when the spec root IS the target root', () => {
    expect(specRootRelInsideTarget("/a/target", "/a/target")).toBe("");
  });

  it("returns null when the spec root is outside the target", () => {
    expect(specRootRelInsideTarget("/a/target", "/a/elsewhere/spec")).toBeNull();
    expect(specRootRelInsideTarget("/a/target", "/a/target/../sneaky")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end path resolution through executeProperties                       */
/* -------------------------------------------------------------------------- */

describe("property imports resolve from the spec's real location (fix)", () => {
  let target: string;

  beforeEach(async () => {
    // A realistic target with a source module a property will import by a
    // relative path, plus a spec root INSIDE it two directories deep.
    target = await mkdtemp(join(tmpdir(), "spec-lantern-import-target-"));
    await writeFile(
      join(target, "package.json"),
      JSON.stringify({ name: "target", version: "1.0.0" }) + "\n",
    );
    await mkdir(join(target, "src", "utils"), { recursive: true });
    await writeFile(
      join(target, "src", "utils", "openingHoursParser.ts"),
      "export function getClosingSoonInfo() { return null; }\n",
    );
  });

  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
  });

  it("spec root INSIDE the target: property runs in place and its relative import resolves", async () => {
    // Spec root under the target, two dirs deep: <target>/.spec-lantern/src-utils.
    // A property there importing "../../../src/utils/openingHoursParser" resolves
    // from <copy>/.spec-lantern/src-utils/properties/ up three dirs to <copy>/src.
    const specRel = ".spec-lantern/src-utils";
    const specRoot = join(target, specRel);
    await mkdir(join(specRoot, "properties"), { recursive: true });
    await writeFile(
      join(specRoot, "properties", "property-1.claim-24h.test.ts"),
      '// Feature: spec-lantern, Property 1\n' +
        'import { getClosingSoonInfo } from "../../../src/utils/openingHoursParser";\n' +
        "export {};\n",
    );

    const runner = importCheckingRunner();
    const request: PropertyExecutionRequest = {
      targetRepoRef: target,
      properties: [makeProperty("property-1.claim-24h")],
      phase: "initial",
    };
    const result = await executeProperties(request, { runner, specRoot });

    // The runner was handed the in-place path (NOT a flattened properties/ path)
    // and both the file and its relative import resolved.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.propertyTestFile).toBe(
      `${specRel}/properties/property-1.claim-24h.test.ts`,
    );
    expect(result.results[0]).toEqual({
      propertyId: "property-1.claim-24h",
      outcome: "VERDICT",
      verdict: "PASS",
    });
  });

  it("spec root OUTSIDE the target: whole spec copied to the fixed mount path", async () => {
    const specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-import-spec-"));
    try {
      await mkdir(join(specRoot, "properties"), { recursive: true });
      // An external spec must import via the alias, not a relative path; use a
      // no-import property so the runner's PASS reflects placement only.
      await writeFile(
        join(specRoot, "properties", "property-2.claim-x.test.ts"),
        "// Feature: spec-lantern, Property 2\nexport {};\n",
      );

      const runner = importCheckingRunner();
      const request: PropertyExecutionRequest = {
        targetRepoRef: target,
        properties: [makeProperty("property-2.claim-x")],
        phase: "initial",
      };
      const result = await executeProperties(request, { runner, specRoot });

      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.propertyTestFile).toBe(
        `${EXTERNAL_SPEC_MOUNT_REL}/properties/property-2.claim-x.test.ts`,
      );
      expect(result.results[0]?.outcome).toBe("VERDICT");
    } finally {
      await rm(specRoot, { recursive: true, force: true });
    }
  });
});
