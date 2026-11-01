/**
 * Live entry point for the walking-skeleton execute path (task 4.3).
 *
 * This is the thin end-to-end slice that proves spec-lantern's "execute, don't
 * trust" thesis on a single property. It calls `executeWalkingSkeleton` from the
 * built package, which:
 *   1. loads the task-4.1 Claim / property test file / comment-trusting PASS
 *      Predicted_Result for the writing-tracker monthly-ordering claim (via
 *      `resolveClaimLinkage` in @spec-lantern/types),
 *   2. copies sandbox/writing-tracker (READ-ONLY source) into a GITIGNORED
 *      working copy under the repo (NEVER /tmp — the macOS Podman machine shares
 *      /Users but not /tmp), excluding node_modules, drops the task-4.1 property
 *      file + a vitest config (@ -> src alias + jsdom) into it, and mounts ONLY
 *      that working copy,
 *   3. dispatches the ONE property into the task-4.2 rootless-Podman runner,
 *      rendering the REAL PeriodProgressSummary component INSIDE the container
 *      (never the host), and
 *   4. surfaces the executed ActualResult next to the PASS prediction and makes
 *      the contradiction explicit.
 *
 * Expected result: VERDICT FAIL with a Counterexample (the real component builds
 * the 6 months already most-recent-first then calls `.reverse()`, so the first
 * monthly row is the OLDEST month, not the current month — e.g. now = Jan 2000
 * yields first row "Aug 1999"), contradicting the comment-trusting PASS
 * prediction.
 *
 * Exit status: non-zero unless the prediction was contradicted by an executed
 * verdict, so this doubles as a smoke check of the skeleton.
 */
import { executeWalkingSkeleton } from "./dist/index.js";

const outcome = await executeWalkingSkeleton({
  log: (message) => console.log(`[execute-path] ${message}`),
});

console.log("\nPREDICTED (comment-trusting, read-only):");
console.log(JSON.stringify(outcome.predicted, null, 2));

console.log("\nACTUAL (executed inside the container):");
console.log(JSON.stringify(outcome.actual, null, 2));

console.log("\nSURFACED OUTCOME:");
console.log(`  predictedVerdict        : ${outcome.predictedVerdict}`);
console.log(`  actualVerdict           : ${String(outcome.actualVerdict)}`);
console.log(`  predictionContradicted  : ${outcome.predictionContradicted}`);
console.log(`\n${outcome.summary}`);

if (!outcome.predictionContradicted) {
  console.error(
    "\nFAILED: expected the execution-observed verdict to contradict the " +
      "comment-trusting PASS prediction, but it did not.",
  );
  process.exit(1);
}

console.log(
  "\nOK: execution contradicted the comment-trusting PASS prediction " +
    "(walking skeleton proven end-to-end).",
);
