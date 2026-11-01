/**
 * The thinnest end-to-end execute path for the walking skeleton (task 4.3).
 *
 * This module wires the two pieces the earlier skeleton tasks built into one
 * vertical slice that PROVES the "execute, don't trust" thesis on a single
 * property:
 *
 *   task 4.1 artifacts  ──►  task 4.2 runner  ──►  surfaced contradiction
 *   (Claim + property +      (runPropertyIn-        (comment-trusting PASS
 *    comment-trusting         Container, rootless    prediction vs the
 *    PASS prediction)         Podman)                execution-observed FAIL)
 *
 * What it does, minimally:
 *  1. Loads the task-4.1 Claim / property-test-file / Predicted_Result for the
 *     writing-tracker monthly-ordering claim, using `resolveClaimLinkage()`
 *     from `@spec-lantern/types` to derive the on-disk paths from the Claim id
 *     and property number (so the 1:1 Claim → property → prediction linkage is
 *     resolved from the canonical layout, not hard-coded paths).
 *  2. Reads the read-only, comment-trusting Predicted_Result (PASS).
 *  3. Dispatches the ONE property into `runPropertyInContainer` — the task-4.2
 *     rootless-Podman runner — executing it against the writing-tracker target
 *     INSIDE the container, never on the host. It reuses the repo-relative
 *     fixture-staging approach from `verify-runner.mjs` so it works on macOS
 *     (the Podman machine shares `/Users` but NOT `/tmp`, so the mounted
 *     fixture must live under the repo).
 *  4. Compares the executed `ActualResult` (expected VERDICT FAIL, oldest-month
 *     first, with its Counterexample) against the PASS prediction and SURFACES
 *     the contradiction.
 *
 * Scope: this is the THIN skeleton wiring, not the full pipeline. Prediction
 * locking (task 7), the Safety Gate (task 8), the two-phase network topology
 * (task 9), the Comparison Engine (task 14), the Revive loop (task 15), report
 * assembly (task 16) and the UI (task 18) are deliberately NOT here. The one
 * exported entry point — {@link executeWalkingSkeleton} — is the seam those
 * later tasks build on: it already returns the prediction, the actual result,
 * and the surfaced mismatch in structured form.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveClaimLinkage,
  type ActualResult,
  type PredictedResult,
  type Verdict,
} from "@spec-lantern/types";
import { runPropertyInContainer } from "./runner/podman-runner.js";

/* -------------------------------------------------------------------------- */
/* Skeleton artifact coordinates (task 4.1)                                   */
/* -------------------------------------------------------------------------- */

/** The one Claim the walking skeleton evaluates. */
const SKELETON_CLAIM_ID = "claim-monthly-order";

/** Its property number (`property-1.claim-monthly-order.*`). */
const SKELETON_PROPERTY_NUMBER = 1;

/**
 * The propertyId the runner and prediction agree on. It matches the
 * `{n}.{claimId}` stem of the on-disk artifact filenames, which is also what
 * the task-4.1 Predicted_Result records.
 */
const SKELETON_PROPERTY_ID = `property-${SKELETON_PROPERTY_NUMBER}.${SKELETON_CLAIM_ID}`;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Default spec root holding the task-4.1 artifacts:
 *   packages/mcp-server/skeleton/writing-tracker-monthly-order/
 * Resolved relative to the compiled module (dist/) so it works from the built
 * package as well as ts-node style runs.
 */
const DEFAULT_SPEC_ROOT = resolve(
  here,
  "..",
  "skeleton",
  "writing-tracker-monthly-order",
);

/** Default home for the repo-relative staged fixture (gitignored). */
const DEFAULT_FIXTURE_DIR = resolve(here, "..", "skeleton", ".fixture");

/* -------------------------------------------------------------------------- */
/* Result shape surfaced to callers                                           */
/* -------------------------------------------------------------------------- */

/**
 * The surfaced outcome of the walking skeleton: the comment-trusting prediction
 * next to the execution-observed actual result, with the mismatch made
 * explicit. This is the structured seam later tasks (comparison, report, UI)
 * consume.
 */
export interface WalkingSkeletonOutcome {
  /** The property that was executed. */
  propertyId: string;
  /** The read-only, comment-trusting prediction loaded from disk (PASS). */
  predicted: PredictedResult;
  /** What executing the property against writing-tracker actually produced. */
  actual: ActualResult;
  /**
   * The predicted verdict vs the actual verdict, when the run produced a
   * verdict. `null` for `actualVerdict` means the run did not terminate in
   * PASS/FAIL (timeout / execution error / runner unavailable) — those are
   * never folded into a verdict.
   */
  predictedVerdict: Verdict;
  actualVerdict: Verdict | null;
  /**
   * TRUE exactly when the run produced a verdict that disagrees with the
   * prediction — i.e. the central contradiction the skeleton exists to prove
   * (comment-trusting PASS vs executed FAIL).
   */
  predictionContradicted: boolean;
  /** Human-readable one-line summary of what was surfaced. */
  summary: string;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface ExecuteWalkingSkeletonOptions {
  /** Spec root holding the task-4.1 artifacts. Defaults to the skeleton dir. */
  specRoot?: string;
  /**
   * Where to stage the repo-relative fixture the container mounts. MUST live
   * under the repo (under `/Users` on macOS). Defaults to
   * `packages/mcp-server/skeleton/.fixture`.
   */
  fixtureDir?: string;
  /**
   * Per-run execution timeout in seconds handed to the runner. Generous by
   * default because the first container run pulls the image and installs the
   * toolchain.
   */
  timeoutSeconds?: number;
  /** Optional sink for progress lines (defaults to no-op). */
  log?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Artifact loading (task 4.1 → in-memory)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Load the comment-trusting Predicted_Result for the skeleton property from the
 * on-disk prediction file whose path is resolved via `resolveClaimLinkage()`.
 */
async function loadPrediction(specRoot: string): Promise<PredictedResult> {
  const linkage = resolveClaimLinkage(
    specRoot,
    SKELETON_CLAIM_ID,
    SKELETON_PROPERTY_NUMBER,
  );
  const raw = await readFile(linkage.predictedResultFile, "utf8");
  const parsed = JSON.parse(raw) as PredictedResult;

  if (parsed.propertyId !== SKELETON_PROPERTY_ID) {
    throw new Error(
      `prediction propertyId "${parsed.propertyId}" does not match the ` +
        `skeleton property "${SKELETON_PROPERTY_ID}"`,
    );
  }
  if (parsed.verdict !== "PASS" && parsed.verdict !== "FAIL") {
    throw new Error(
      `prediction verdict must be PASS or FAIL, got "${String(parsed.verdict)}"`,
    );
  }
  return parsed;
}

/**
 * Stage the self-contained, repo-relative fixture the container mounts, exactly
 * as `verify-runner.mjs` does: a minimal `package.json` plus the single task-4.1
 * property test file, under `fixtureDir` (which lives under the repo so it is
 * visible in the macOS Podman VM). Returns the in-fixture relative path to the
 * property test file.
 */
async function stageFixture(
  specRoot: string,
  fixtureDir: string,
): Promise<{ propertyTestFile: string }> {
  const linkage = resolveClaimLinkage(
    specRoot,
    SKELETON_CLAIM_ID,
    SKELETON_PROPERTY_NUMBER,
  );

  // Fresh fixture every run — NEVER under /tmp (invisible in the macOS VM).
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(join(fixtureDir, "properties"), { recursive: true });

  // Minimal package.json so the container's npm install resolves the test
  // toolchain the runner adds (vitest + fast-check). The skeleton property
  // reproduces the ordering algorithm inline (task 4.1) so no target deps are
  // required.
  await writeFile(
    join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "spec-lantern-runner-fixture",
        private: true,
        version: "0.0.0",
        type: "module",
      },
      null,
      2,
    ) + "\n",
  );

  const propertyTestFile = "properties/property-1.claim-monthly-order.test.ts";
  await cp(linkage.propertyTestFile, join(fixtureDir, propertyTestFile));

  return { propertyTestFile };
}

/* -------------------------------------------------------------------------- */
/* The execute path                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Run the thinnest execute path end-to-end and surface the contradiction.
 *
 * Loads the task-4.1 artifacts, reads the PASS prediction, dispatches the ONE
 * property into the task-4.2 rootless-Podman runner (executing against the
 * writing-tracker ordering logic INSIDE the container), then compares the
 * executed `ActualResult` against the prediction and reports the mismatch.
 *
 * This never runs target code on the host: all execution happens via
 * `runPropertyInContainer`, which returns `RUNNER_UNAVAILABLE` rather than
 * falling back to the host when Podman is absent.
 */
export async function executeWalkingSkeleton(
  options: ExecuteWalkingSkeletonOptions = {},
): Promise<WalkingSkeletonOutcome> {
  const specRoot = options.specRoot ?? DEFAULT_SPEC_ROOT;
  const fixtureDir = options.fixtureDir ?? DEFAULT_FIXTURE_DIR;
  const timeoutSeconds = options.timeoutSeconds ?? 300;
  const log = options.log ?? (() => undefined);

  // 1. Load the comment-trusting prediction (read-only, pre-execution).
  log(`Loading task-4.1 artifacts for ${SKELETON_PROPERTY_ID} from ${specRoot}`);
  const predicted = await loadPrediction(specRoot);
  log(`Comment-trusting Predicted_Result: ${predicted.verdict}`);

  try {
    // 2. Stage the repo-relative fixture the container will mount (macOS-safe).
    log(`Staging repo-relative fixture at ${fixtureDir}`);
    const { propertyTestFile } = await stageFixture(specRoot, fixtureDir);

    // 3. Dispatch the ONE property into the task-4.2 runner. Execution happens
    //    INSIDE the rootless Podman container against the fixture mount, never
    //    on the host.
    log("Dispatching the property into the rootless Podman runner…");
    const actual = await runPropertyInContainer({
      propertyId: SKELETON_PROPERTY_ID,
      targetRepoPath: fixtureDir,
      propertyTestFile,
      timeoutSeconds,
    });
    log(`Runner returned outcome: ${actual.outcome}`);

    // 4. Compare the executed result against the prediction and surface it.
    return surfaceOutcome(predicted, actual);
  } finally {
    // 5. Clean up the staged fixture so nothing leaks between runs.
    await rm(fixtureDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Build the surfaced {@link WalkingSkeletonOutcome} from a prediction and an
 * executed actual result, making the predicted-vs-actual contradiction
 * explicit. A mismatch is flagged ONLY when the run produced a verdict (closed-
 * union discipline: timeouts / errors / unavailability are never compared as if
 * they were PASS/FAIL — that nuance is the Comparison Engine's job in task 14,
 * but even the skeleton must not pretend a non-verdict is a FAIL).
 */
export function surfaceOutcome(
  predicted: PredictedResult,
  actual: ActualResult,
): WalkingSkeletonOutcome {
  const predictedVerdict = predicted.verdict;
  const actualVerdict =
    actual.outcome === "VERDICT" ? actual.verdict : null;
  const predictionContradicted =
    actualVerdict !== null && actualVerdict !== predictedVerdict;

  let summary: string;
  if (actualVerdict === null) {
    summary =
      `Property ${predicted.propertyId}: predicted ${predictedVerdict}, but ` +
      `execution produced no verdict (${actual.outcome}` +
      ("reason" in actual ? `: ${actual.reason}` : "") +
      `). No comparison made.`;
  } else if (predictionContradicted) {
    const cx =
      actual.outcome === "VERDICT" && actual.counterexample
        ? ` Counterexample: input=${stringifyCompact(
            actual.counterexample.input,
          )} observedOutput=${stringifyCompact(
            actual.counterexample.observedOutput,
          )}`
        : "";
    summary =
      `CONTRADICTION — the comment-trusting prediction said ` +
      `${predictedVerdict}, but executing property ${predicted.propertyId} ` +
      `against writing-tracker produced ${actualVerdict}.${cx}`;
  } else {
    summary =
      `Property ${predicted.propertyId}: execution (${actualVerdict}) agrees ` +
      `with the prediction (${predictedVerdict}).`;
  }

  return {
    propertyId: predicted.propertyId,
    predicted,
    actual,
    predictedVerdict,
    actualVerdict,
    predictionContradicted,
    summary,
  };
}

/** Compact one-line stringification for surfacing counterexample values. */
function stringifyCompact(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 300);
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? String(value);
  } catch {
    return String(value);
  }
}
