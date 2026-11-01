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
