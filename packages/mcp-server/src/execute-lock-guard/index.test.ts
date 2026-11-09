// Feature: spec-lantern — execute-time lock guard unit tests (GAP 1)
//
// The guard refuses to run a Correctness_Property whose current test-file source
// drifted from its locked `propertyContentHash`, while allowing properties with
// no lock or a matching hash, and recording the hash actually checked. A
// supersede that re-locks the edited source must make the property allowed
// again. These checks drive the real on-disk layout (properties/ + predictions/
// + locks/) with a real lock written by lockPrediction.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CorrectnessProperty, PredictedResult } from "@spec-lantern/types";
import {
  predictedResultFilePath,
  propertyTestFilePath,
  propertyTag,
} from "@spec-lantern/types";
import {
  lockPrediction,
  supersedePredictionLock,
  type LockTarget,
} from "../prediction-lock/index.js";
import { checkPropertyLockDrift } from "./index.js";

const CLAIM_ID = "claim-monthly-order";
const PROPERTY_NUMBER = 1;
const PROPERTY_ID = `property-${PROPERTY_NUMBER}.${CLAIM_ID}`;

let specRoot: string;

const target = (): LockTarget => ({
  specRoot,
  claimId: CLAIM_ID,
  propertyNumber: PROPERTY_NUMBER,
});

const property = (): CorrectnessProperty => ({
  id: PROPERTY_ID,
  claimId: CLAIM_ID,
  title: "most recent month first",
  statement: "for all months, the first row is the current month",
  kind: "function",
  validatesRequirements: [],
});

function propertySource(extra = ""): string {
  return [
    `// ${propertyTag(PROPERTY_NUMBER, "most recent month first")}`,
    `import { test, expect } from "vitest";`,
    `test("most recent month first", () => { expect(1).toBe(1); });${extra}`,
    "",
  ].join("\n");
}

function prediction(verdict: "PASS" | "FAIL" = "FAIL"): PredictedResult {
  return {
    propertyId: PROPERTY_ID,
    verdict,
    recordedAt: "2025-01-01T00:00:00.000Z",
    immutable: true,
  };
}

async function writeFixtures(
  pred: PredictedResult = prediction(),
  source: string = propertySource(),
): Promise<void> {
  await mkdir(join(specRoot, "predictions"), { recursive: true });
  await mkdir(join(specRoot, "properties"), { recursive: true });
  await writeFile(
    predictedResultFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
    `${JSON.stringify(pred, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    propertyTestFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
    source,
    "utf8",
  );
}

beforeEach(async () => {
  specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-guard-"));
});

afterEach(async () => {
  await rm(specRoot, { recursive: true, force: true });
});

describe("checkPropertyLockDrift (GAP 1)", () => {
  it("allows a property that has no lock (locking is a separate precondition)", async () => {
    await writeFixtures();
    // No lock written.
    const result = await checkPropertyLockDrift({
      specRoot,
      properties: [property()],
    });
    expect(result.allowed.map((p) => p.id)).toEqual([PROPERTY_ID]);
    expect(result.refused).toEqual([]);
    // No lock => no recorded hash.
    expect(result.propertyContentHashes).toEqual({});
  });

  it("allows a property whose source matches its lock and records the hash", async () => {
    await writeFixtures();
    await lockPrediction(target(), { now: () => "2025-02-02T00:00:00.000Z" });

    const result = await checkPropertyLockDrift({
      specRoot,
      properties: [property()],
    });
    expect(result.allowed.map((p) => p.id)).toEqual([PROPERTY_ID]);
    expect(result.refused).toEqual([]);
    expect(result.propertyContentHashes[PROPERTY_ID]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a property whose source drifted from its lock", async () => {
    await writeFixtures();
    await lockPrediction(target(), { now: () => "2025-02-02T00:00:00.000Z" });

    // Edit the property file after locking, WITHOUT a supersede.
    await writeFile(
      propertyTestFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      propertySource(" // edited after locking"),
      "utf8",
    );

    const result = await checkPropertyLockDrift({
      specRoot,
      properties: [property()],
    });
    expect(result.allowed).toEqual([]);
    expect(result.refused.map((r) => r.propertyId)).toEqual([PROPERTY_ID]);
    expect(result.refused[0]?.reason).toContain("supersede_prediction_lock");
    // A refused property contributes no "ran-against" hash.
    expect(result.propertyContentHashes[PROPERTY_ID]).toBeUndefined();
  });

  it("allows the property again after a supersede re-locks the edited source", async () => {
    await writeFixtures();
    await lockPrediction(target(), { now: () => "2025-02-02T00:00:00.000Z" });

    // Edit the property file, then record a supersede re-locking the edit.
    await writeFile(
      propertyTestFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      propertySource(" // harness fix"),
      "utf8",
    );
    const superseded = await supersedePredictionLock(target(), {
      reason: "fixed a harness defect in the property test",
      now: () => "2025-03-03T00:00:00.000Z",
    });
    expect(superseded.issue).toBeNull();
    expect(superseded.lock).not.toBeNull();

    const result = await checkPropertyLockDrift({
      specRoot,
      properties: [property()],
    });
    expect(result.allowed.map((p) => p.id)).toEqual([PROPERTY_ID]);
    expect(result.refused).toEqual([]);
    expect(result.propertyContentHashes[PROPERTY_ID]).toMatch(/^[0-9a-f]{64}$/);
  });
});
