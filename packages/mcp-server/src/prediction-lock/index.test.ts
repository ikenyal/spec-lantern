// Feature: spec-lantern — prediction-lock unit/integration tests (task 7.1)
//
// Example-based coverage for the prediction-lock tool: computing a content
// hash + timestamp over a Predicted_Result and the Correctness_Property test
// file it refers to, persisting the lock before execution (R3.4), and reading
// the ORIGINALLY recorded verdict back for comparison even after the prediction
// or property file is edited (R3.5).
//
// The checks drive the real on-disk layout: each test writes a temp spec root
// with predictions/ + properties/ fixtures, locks a prediction, then reads it
// back. The optional property test for immutability is the SEPARATE task 7.2
// and is intentionally not written here.

import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PredictedResult } from "@spec-lantern/types";
import {
  predictedResultFilePath,
  predictionLockFilePath,
  propertyTestFilePath,
  propertyTag,
} from "@spec-lantern/types";
import {
  lockPrediction,
  readPredictionLock,
  readLockedVerdict,
  type LockTarget,
} from "./index.js";

/* -------------------------------------------------------------------------- */
/* Fixture helpers                                                            */
/* -------------------------------------------------------------------------- */

const CLAIM_ID = "claim-monthly-order";
const PROPERTY_NUMBER = 1;
const PROPERTY_ID = `property-${PROPERTY_NUMBER}.${CLAIM_ID}`;

let specRoot: string;

const target = (): LockTarget => ({
  specRoot,
  claimId: CLAIM_ID,
  propertyNumber: PROPERTY_NUMBER,
});

/** A minimal, well-formed property test file source carrying the tag. */
function propertySource(): string {
  return [
    `// ${propertyTag(PROPERTY_NUMBER, "most recent month first")}`,
    `import { test, expect } from "vitest";`,
    `test("most recent month first", () => { expect(1).toBe(1); });`,
    "",
  ].join("\n");
}

/** A well-formed Predicted_Result with an overridable verdict. */
function prediction(verdict: "PASS" | "FAIL" = "PASS"): PredictedResult {
  return {
    propertyId: PROPERTY_ID,
    verdict,
    recordedAt: "2025-01-01T00:00:00.000Z",
    immutable: true,
  };
}

/** Write the prediction + property fixtures under the temp spec root. */
async function writeFixtures(
  pred: PredictedResult = prediction(),
  source: string = propertySource(),
): Promise<void> {
  const predPath = predictedResultFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID);
  const propPath = propertyTestFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID);
  await mkdir(join(specRoot, "predictions"), { recursive: true });
  await mkdir(join(specRoot, "properties"), { recursive: true });
  await writeFile(predPath, `${JSON.stringify(pred, null, 2)}\n`, "utf8");
  await writeFile(propPath, source, "utf8");
}

beforeEach(async () => {
  specRoot = await mkdtemp(join(tmpdir(), "spec-lantern-lock-"));
});

afterEach(async () => {
  await rm(specRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Locking (R3.4)                                                             */
/* -------------------------------------------------------------------------- */

describe("lockPrediction (task 7.1, R3.4)", () => {
  it("writes a lock with the recorded verdict, a sha256 hash, and a timestamp", async () => {
    await writeFixtures(prediction("PASS"));

    const result = await lockPrediction(target(), {
      now: () => "2025-02-02T00:00:00.000Z",
    });

    expect(result.issue).toBeNull();
    expect(result.lock).not.toBeNull();
    expect(result.lock?.propertyId).toBe(PROPERTY_ID);
    expect(result.lock?.verdict).toBe("PASS");
    expect(result.lock?.hashAlgorithm).toBe("sha256");
    expect(result.lock?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.lock?.lockedAt).toBe("2025-02-02T00:00:00.000Z");

    // Persisted on disk at the canonical layout path.
    const lockPath = predictionLockFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID);
    const onDisk = JSON.parse(await readFile(lockPath, "utf8"));
    expect(onDisk).toEqual(result.lock);
  });

  it("captures FAIL predictions verbatim", async () => {
    await writeFixtures(prediction("FAIL"));
    const result = await lockPrediction(target());
    expect(result.lock?.verdict).toBe("FAIL");
  });

  it("hashes the property artifact: different property source => different hash", async () => {
    await writeFixtures(prediction("PASS"));
    const first = await lockPrediction(target());

    // Edit the property file's bytes and re-lock; the hash must change.
    await writeFile(
      propertyTestFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      `${propertySource()}// an extra line changes the bytes\n`,
      "utf8",
    );
    const second = await lockPrediction(target());

    expect(first.lock?.contentHash).not.toBe(second.lock?.contentHash);
  });

  it("is stable across cosmetic-only prediction edits (whitespace / recordedAt)", async () => {
    await writeFixtures(prediction("PASS"));
    const first = await lockPrediction(target());

    // Re-write the prediction with the SAME verdict but a different timestamp
    // and formatting. The verdict is what the hash is taken over, so it holds.
    await writeFile(
      predictedResultFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      JSON.stringify({ ...prediction("PASS"), recordedAt: "2025-03-03T12:00:00.000Z" }),
      "utf8",
    );
    const second = await lockPrediction(target());

    expect(first.lock?.contentHash).toBe(second.lock?.contentHash);
  });

  it("reports PREDICTION_MISSING when there is no prediction file", async () => {
    // Only the property file exists.
    await mkdir(join(specRoot, "properties"), { recursive: true });
    await writeFile(
      propertyTestFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      propertySource(),
      "utf8",
    );
    const result = await lockPrediction(target());
    expect(result.lock).toBeNull();
    expect(result.issue?.code).toBe("PREDICTION_MISSING");
  });

  it("reports PROPERTY_FILE_MISSING when the property artifact is absent", async () => {
    await mkdir(join(specRoot, "predictions"), { recursive: true });
    await writeFile(
      predictedResultFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      JSON.stringify(prediction()),
      "utf8",
    );
    const result = await lockPrediction(target());
    expect(result.lock).toBeNull();
    expect(result.issue?.code).toBe("PROPERTY_FILE_MISSING");
  });

  it("rejects a malformed prediction (verdict not PASS/FAIL)", async () => {
    await writeFixtures();
    await writeFile(
      predictedResultFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      JSON.stringify({ ...prediction(), verdict: "MAYBE" }),
      "utf8",
    );
    const result = await lockPrediction(target());
    expect(result.issue?.code).toBe("PREDICTION_MALFORMED");
  });

  it("rejects a prediction whose propertyId does not match the target", async () => {
    await writeFixtures();
    await writeFile(
      predictedResultFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      JSON.stringify({ ...prediction(), propertyId: "property-9.other" }),
      "utf8",
    );
    const result = await lockPrediction(target());
    expect(result.issue?.code).toBe("PREDICTION_PROPERTY_ID_MISMATCH");
  });
});

/* -------------------------------------------------------------------------- */
/* Reading the locked verdict back (R3.5)                                     */
/* -------------------------------------------------------------------------- */

describe("readPredictionLock (task 7.1, R3.5)", () => {
  it("round-trips: reading an unchanged lock returns the locked verdict, no issue", async () => {
    await writeFixtures(prediction("FAIL"));
    await lockPrediction(target());

    const read = await readPredictionLock(target());
    expect(read.issue).toBeNull();
    expect(read.verdict).toBe("FAIL");
    expect(await readLockedVerdict(target())).toBe("FAIL");
  });

  it("returns the ORIGINAL locked verdict even after the prediction is edited (R3.5)", async () => {
    await writeFixtures(prediction("PASS"));
    await lockPrediction(target());

    // Attempt to rewrite the prediction PASS -> FAIL after locking.
    await writeFile(
      predictedResultFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      JSON.stringify(prediction("FAIL")),
      "utf8",
    );

    const read = await readPredictionLock(target());
    // The locked, originally recorded value wins — and drift is flagged.
    expect(read.verdict).toBe("PASS");
    expect(read.issue?.code).toBe("LOCK_CONTENT_DRIFT");
  });

  it("flags drift when the property artifact is edited after locking", async () => {
    await writeFixtures(prediction("PASS"));
    await lockPrediction(target());

    await writeFile(
      propertyTestFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      `${propertySource()}// tampered\n`,
      "utf8",
    );

    const read = await readPredictionLock(target());
    expect(read.verdict).toBe("PASS");
    expect(read.issue?.code).toBe("LOCK_CONTENT_DRIFT");
  });

  it("flags drift (but keeps the locked verdict) when source artifacts vanish", async () => {
    await writeFixtures(prediction("FAIL"));
    await lockPrediction(target());

    await rm(predictedResultFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID));

    const read = await readPredictionLock(target());
    expect(read.verdict).toBe("FAIL");
    expect(read.issue?.code).toBe("LOCK_CONTENT_DRIFT");
  });

  it("reports LOCK_MISSING when no lock has been written", async () => {
    await writeFixtures();
    const read = await readPredictionLock(target());
    expect(read.verdict).toBeNull();
    expect(read.issue?.code).toBe("LOCK_MISSING");
  });

  it("reports LOCK_MALFORMED on a corrupt lock file", async () => {
    await writeFixtures();
    await lockPrediction(target());
    await writeFile(
      predictionLockFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      JSON.stringify({ propertyId: PROPERTY_ID, verdict: "PASS" }),
      "utf8",
    );
    const read = await readPredictionLock(target());
    expect(read.verdict).toBeNull();
    expect(read.issue?.code).toBe("LOCK_MALFORMED");
  });

  it("reports LOCK_INVALID_JSON on a non-JSON lock file", async () => {
    await writeFixtures();
    await lockPrediction(target());
    await writeFile(
      predictionLockFilePath(specRoot, PROPERTY_NUMBER, CLAIM_ID),
      "not json {",
      "utf8",
    );
    const read = await readPredictionLock(target());
    expect(read.issue?.code).toBe("LOCK_INVALID_JSON");
  });
});
