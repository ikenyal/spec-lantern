// Feature: spec-lantern — compare_predictions (change 3)
//
// comparePredictions must: read predicted verdicts ONLY from the on-disk LOCKS
// (never from the caller — it has no channel for a caller-supplied verdict),
// run the Comparison Engine against a persisted execution result, group symptom
// comparisons under a root cause and count a lie ONCE per root cause, and write
// <specRoot>/comparison.json.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PredictedResult } from "@spec-lantern/types";
import { lockPrediction } from "../prediction-lock/index.js";
import { comparePredictions } from "./index.js";

/** Author a property file + a locked PASS/FAIL prediction for a property. */
async function lockProperty(
  specRoot: string,
  propertyNumber: number,
  claimId: string,
  verdict: "PASS" | "FAIL",
): Promise<void> {
  const stem = `property-${propertyNumber}.${claimId}`;
  await writeFile(
    join(specRoot, "properties", `${stem}.test.ts`),
    `// Feature: spec-lantern, Property ${propertyNumber}: ${claimId}\nexport {};\n`,
  );
  const prediction: PredictedResult = {
    propertyId: stem,
    verdict,
    recordedAt: "2025-01-01T00:00:00.000Z",
    immutable: true,
  };
  await writeFile(
    join(specRoot, "predictions", `${stem}.predicted.json`),
    JSON.stringify(prediction, null, 2),
  );
  const result = await lockPrediction(
    { specRoot, claimId, propertyNumber },
    { now: () => "2025-01-01T00:00:00.000Z" },
  );
  if (result.lock === null) {
    throw new Error(`failed to lock ${stem}: ${result.issue?.message}`);
  }
}

describe("comparePredictions (change 3)", () => {
  let specRoot: string;

  beforeEach(async () => {
    specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-compare-"));
    await mkdir(join(specRoot, "properties"), { recursive: true });
    await mkdir(join(specRoot, "predictions"), { recursive: true });
    await mkdir(join(specRoot, "results"), { recursive: true });
  });

  afterEach(async () => {
    await rm(specRoot, { recursive: true, force: true });
  });

  it("reads predicted verdicts from the LOCKS and flags a mismatch", async () => {
    // Root cause: predicted PASS by reading the code, but execution FAILs → a lie.
    await lockProperty(specRoot, 1, "claim-root", "PASS");

    const resultsPath = join(specRoot, "results", "run.json");
    await writeFile(
      resultsPath,
      JSON.stringify({
        results: [
          {
            propertyId: "property-1.claim-root",
            outcome: "VERDICT",
            verdict: "FAIL",
          },
        ],
        executionContexts: {},
      }),
    );

    const result = await comparePredictions({ specRoot, resultsPath });

    const row = result.comparisons.find(
      (c) => c.propertyId === "property-1.claim-root",
    );
    // Predicted came from the lock (PASS); actual is FAIL → mismatch + bug.
    expect(row?.predicted).toBe("PASS");
    expect(row?.status).toBe("PREDICTION_MISMATCH");
    expect(row?.confirmedBug).toBe(true);
    expect(result.lieCount).toBe(1);
    expect(result.confirmedBugCount).toBe(1);

    // comparison.json was written verbatim.
    const written = JSON.parse(
      await readFile(join(specRoot, "comparison.json"), "utf8"),
    );
    expect(written.lieCount).toBe(1);
    expect(result.comparisonPath).toBe(join(specRoot, "comparison.json"));
  });

  it("groups symptoms under a root cause and counts the lie ONCE", async () => {
    // One root cause (mismatch) plus two symptoms (also mismatches). Without
    // grouping that would be 3 lies; grouped it is 1.
    await lockProperty(specRoot, 1, "claim-root", "PASS");
    await lockProperty(specRoot, 2, "claim-sym-a", "PASS");
    await lockProperty(specRoot, 3, "claim-sym-b", "PASS");

    const resultsPath = join(specRoot, "results", "run.json");
    await writeFile(
      resultsPath,
      JSON.stringify({
        results: [
          { propertyId: "property-1.claim-root", outcome: "VERDICT", verdict: "FAIL" },
          { propertyId: "property-2.claim-sym-a", outcome: "VERDICT", verdict: "FAIL" },
          { propertyId: "property-3.claim-sym-b", outcome: "VERDICT", verdict: "FAIL" },
        ],
        executionContexts: {},
      }),
    );

    const result = await comparePredictions({
      specRoot,
      resultsPath,
      rootCauses: {
        "property-1.claim-root": ["property-2.claim-sym-a", "property-3.claim-sym-b"],
      },
    });

    // Counted ONCE per root cause, not once per symptom.
    expect(result.lieCount).toBe(1);
    expect(result.confirmedBugCount).toBe(3);
    expect(result.rootCauseGroups).toHaveLength(1);
    const group = result.rootCauseGroups[0];
    expect(group.rootCausePropertyId).toBe("property-1.claim-root");
    expect(group.symptoms.map((s) => s.propertyId)).toEqual([
      "property-2.claim-sym-a",
      "property-3.claim-sym-b",
    ]);
    expect(group.isLie).toBe(true);
  });

  it("reads actuals from .postFixExecution.results for an apply-fixes result", async () => {
    await lockProperty(specRoot, 1, "claim-root", "FAIL");
    const resultsPath = join(specRoot, "results", "post.json");
    await writeFile(
      resultsPath,
      JSON.stringify({
        postFixExecution: {
          results: [
            { propertyId: "property-1.claim-root", outcome: "VERDICT", verdict: "FAIL" },
          ],
          executionContexts: {},
        },
        transitions: [],
      }),
    );
    const result = await comparePredictions({ specRoot, resultsPath });
    // Predicted FAIL (lock), actual FAIL → MATCH, confirmed bug, no lie.
    const row = result.comparisons[0];
    expect(row.predicted).toBe("FAIL");
    expect(row.status).toBe("MATCH");
    expect(result.lieCount).toBe(0);
    expect(result.confirmedBugCount).toBe(1);
  });
});
