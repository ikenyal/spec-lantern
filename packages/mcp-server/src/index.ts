/**
 * @spec-lantern/mcp-server
 *
 * Home of the MCP_Server deliverable: the sandbox-boundary owner that exposes
 * MCP tools (`execute_properties`, `apply_fixes_and_reexecute`,
 * `replay_counterexample`) and owns the Isolated_Runner. Tools, the Safety
 * Gate, and the runner lifecycle are implemented in tasks 7-16. This
 * scaffolding entrypoint only confirms the package wiring.
 */
import { SPEC_LANTERN } from "@spec-lantern/types";

export const MCP_SERVER_FEATURE = SPEC_LANTERN;

/**
 * Minimal local rootless Podman runner for a single Correctness_Property
 * (task 4.2). Task 4.3 dispatches one property into the runner via
 * `runPropertyInContainer`.
 */
export {
  runPropertyInContainer,
  type PodmanRunnerRequest,
} from "./runner/podman-runner.js";

/**
 * The thinnest end-to-end execute path (task 4.3): load the task-4.1 Claim /
 * property / comment-trusting PASS prediction, dispatch the one property into
 * the task-4.2 runner, execute it against writing-tracker inside the container,
 * and surface the resulting FAIL as a contradiction of the PASS prediction.
 * This is the seam the full pipeline (comparison, report, UI) builds on.
 */
export {
  executeWalkingSkeleton,
  surfaceOutcome,
  type WalkingSkeletonOutcome,
  type ExecuteWalkingSkeletonOptions,
} from "./execute-path.js";

/**
 * The artifact Validator (task 6). It reads the on-disk spec-lantern artifacts
 * and reports contract violations as STRUCTURED DATA (never throwing on a
 * malformed artifact). Task 6.1 validates Claims, the 1:1 Claim→property
 * mapping, and unverifiable Claims; task 6.2 validates Observed_Deviations'
 * references and the empty-list case; task 6.3 extends the same module.
 */
export {
  validateSpec,
  validateClaimArtifacts,
  validateClaims,
  validateObservedDeviationArtifacts,
  validateObservedDeviations,
  validatePropertyTestFileArtifacts,
  validatePropertyTestFiles,
  discoverPropertyFiles,
  combineResults,
  makeResult,
  type ValidationSeverity,
  type ValidationCode,
  type ValidationIssue,
  type ValidationResult,
  type DiscoveredPropertyFile,
  type DiscoveredPropertyFileWithSource,
} from "./validator/index.js";

/**
 * The prediction-lock tool (task 7.1). At the execution-start boundary it
 * computes a content hash (SHA-256) + timestamp over each Predicted_Result and
 * the Correctness_Property test file it refers to, and persists a
 * Prediction_Lock so the prediction cannot silently change once execution
 * begins (R3.4, R3.5). `readPredictionLock`/`readLockedVerdict` read the locked
 * value back for the Comparison Engine (task 14), flagging any drift of the
 * prediction or property artifact from what the lock was taken over.
 */
export {
  lockPrediction,
  readPredictionLock,
  readLockedVerdict,
  type LockCode,
  type LockIssue,
  type LockResult,
  type LockReadResult,
  type LockTarget,
  type LockPredictionOptions,
} from "./prediction-lock/index.js";
