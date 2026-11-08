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
 * The Isolated_Runner contract (task 8.2). This GENERALIZES the concrete
 * task-9 two-phase runner into an explicit interface — the single execution
 * target for Target_Repo code — so the Safety Gate (task 8.1), network topology
 * (task 9), and orchestrator (task 10) program against the contract rather than
 * the concrete Podman function. The contract codifies the two overriding
 * host-safety invariants: mount ONLY the target working directory and confine
 * file access to that boundary (R12.6); and on runner-create failure or
 * unavailability abort with a `RUNNER_UNAVAILABLE` outcome identifying the
 * reason, never falling back to host execution (R5.8, R12.5).
 * `podmanIsolatedRunner` is the MVP-scope implementation (a thin adapter over
 * `runTwoPhase`); `getIsolatedRunner` selects it.
 */
export {
  getIsolatedRunner,
  podmanIsolatedRunner,
  type IsolatedRunner,
  type IsolatedRunnerRequest,
} from "./runner/isolated-runner.js";

/**
 * The thinnest end-to-end execute path (task 4.3): load the task-4.1 Claim /
 * property / comment-trusting PASS prediction, dispatch the one property through
 * the task-9 two-phase runner (`runTwoPhase`), execute it against writing-tracker
 * inside the container, and surface the resulting FAIL as a contradiction of the
 * PASS prediction. This is the seam the full pipeline (comparison, report, UI)
 * builds on.
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

/**
 * The Safety Gate (task 8.1): the MCP_Server's PRE-execution classification
 * chokepoint for host safety. Every Property_Execution_Request and every
 * fix-application request passes through {@link classifyOperation} before
 * anything runs; the gate accepts only runner-targeted operations and rejects
 * any that would run Target_Repo code in the host process or host shell,
 * reporting a `SAFETY_VIOLATION` (reusing the closed `ActualResult` union) and
 * leaving host filesystem and process state unchanged (R5.2, R12.1, R12.4). It
 * is pure/decision-only — it never spawns a process; enforcing
 * container-not-host AT execution time is the runner's job (task 8.2 / 9).
 */
export {
  classifyOperation,
  classifyPropertyExecution,
  classifyFixApplication,
  isAccepted,
  type GateOperation,
  type FixApplicationRequest,
  type SafetyDecision,
  type SafetyViolation,
  type SafetyViolationCode,
  type ExecutionTarget,
} from "./safety-gate/index.js";

/**
 * The install-phase network topology (task 9.1). Builds the internal-only
 * Podman network + the single outbound-capable Verdaccio registry proxy, runs
 * `npm install --ignore-scripts --registry <proxy>` in an install container so
 * only the package registry is reachable with lifecycle scripts disabled
 * (R12.2), and ALWAYS tears the topology down before the test phase begins
 * (R5.4, R12.3). `runInstallPhase` is the orchestration seam the two-phase test
 * runner (task 9.2) sequences AFTER; the lower-level
 * `createInstallTopology`/`runInstallInContainer`/`teardownInstallTopology`
 * expose the lifecycle for finer-grained composition.
 */
export {
  runInstallPhase,
  createInstallTopology,
  runInstallInContainer,
  teardownInstallTopology,
  type InstallTopology,
  type InstallPhaseOutcome,
  type RunInstallPhaseOptions,
} from "./runner/install-phase.js";

/**
 * The no-network Test_Execution_Phase + two-phase composition (task 9.2).
 * `runTestPhase` runs the Correctness_Property test file inside a rootless
 * Podman container with `--network none` — no network namespace access at all,
 * inbound or outbound, for the entire phase (R12.3) — against the dependencies
 * the install phase already populated, classifying via the shared Vitest
 * classifier so the outcome matches the skeleton runner exactly.
 * `runTwoPhase` is the clean entry point the orchestrator (task 10) calls: it
 * runs `runInstallPhase` FIRST and only starts the no-network test container on
 * install success, surfacing the install's closed non-VERDICT result unchanged
 * otherwise (R5.4).
 */
export {
  runTestPhase,
  runTestPhaseWithContext,
  runTwoPhase,
  runTwoPhaseWithContext,
  type ExecutionWithContext,
  type TestPhaseRequest,
  type TwoPhaseRequest,
} from "./runner/test-phase.js";

/**
 * Execution_Context recording + deterministic seeding/clock pinning (task 10.3).
 * {@link recordExecutionContext} CHOOSES/records the per-execution context
 * (Random_Seed, timezone, Fixed_Current_Time); {@link buildExecutionContextEnv}
 * and {@link buildSeedClockSetupModule}/{@link buildSeedClockVitestConfig}
 * thread it INTO the no-network test container so fast-check is seeded from the
 * recorded Random_Seed and `TZ` is pinned, making the run deterministic and
 * replayable (R6.1, R6.3).
 */
export {
  recordExecutionContext,
  buildExecutionContextEnv,
  buildSeedClockSetupModule,
  buildSeedClockVitestConfig,
  SEED_ENV,
  FIXED_TIME_ENV,
  TIMEZONE_ENV,
  SEED_SETUP_FILE,
  SEED_CONFIG_FILE,
} from "./runner/execution-context.js";

/**
 * jsdom component rendering under a Controllable_Clock (task 12.1). The GENERIC
 * render harness for a props-driven `component_rendered` Correctness_Property
 * (R4.2, R4.3), factored out of the walking skeleton so there is one harness,
 * not two. {@link planComponentRender} decides whether a property is a
 * props-driven render or — for an internally-fetching component recorded
 * unverifiable (R3.6, R4.1) — renders NOTHING. The pure string builders
 * ({@link buildComponentRenderVitestConfig}, {@link buildControllableClockSetupModule},
 * {@link buildDomInteractionShimModule}, {@link buildBackendClientStubModule})
 * emit the jsdom config (the `@` → `src` alias + jsdom env), the OPT-IN
 * Controllable_Clock pinned to the recorded Fixed_Current_Time + fixed `TZ`, the
 * reusable DOM-interaction shims, and the inert backend stub;
 * {@link stageComponentRenderHarness} writes them into the single mounted
 * working directory. The Controllable_Clock is opt-in (wired only by the render
 * config, never globally) so the walking skeleton's self-managed clock is never
 * fought.
 */
export {
  planComponentRender,
  buildComponentRenderVitestConfig,
  buildControllableClockSetupModule,
  buildDomInteractionShimModule,
  buildBackendClientStubModule,
  stageComponentRenderHarness,
  COMPONENT_RENDER_CONFIG_FILE,
  COMPONENT_RENDER_SETUP_FILE,
  COMPONENT_RENDER_SHIM_FILE,
  COMPONENT_RENDER_BACKEND_STUB_FILE,
  type ComponentRenderPlan,
  type ComponentRenderVitestConfigOptions,
  type StageComponentRenderHarnessOptions,
} from "./runner/component-render.js";

/**
 * The execution orchestrator (task 10.1). {@link executeProperties} turns a
 * `PropertyExecutionRequest` into a `PropertyExecutionResult` by routing it
 * through the Safety Gate (task 8) and then the two-phase Isolated_Runner
 * (task 9): a host-bound request is rejected as `SAFETY_VIOLATION` without
 * creating a runner; accepted properties execute inside the runner and return a
 * `VERDICT` (PASS/FAIL) on normal completion (R5.1, R5.2, R5.3, R5.5). Richer
 * Counterexample/timeout/execution-error surfacing (task 10.2) and per-execution
 * Execution_Context recording (task 10.3) build on this seam.
 */
export {
  executeProperties,
  type ExecutePropertiesOptions,
} from "./orchestrator/index.js";

/**
 * Counterexample replay (task 11.1). {@link replayCounterexample} re-runs ONE
 * Correctness_Property through the SAME Safety Gate → Isolated_Runner seam as
 * {@link executeProperties}, but FORCES the recorded Execution_Context
 * (Random_Seed, timezone, Fixed_Current_Time) back through the runner so a
 * deterministic property reproduces the `Actual_Result` that was recorded for
 * the original execution (R6.3). It reuses the runner's verbatim-context path
 * rather than duplicating any execution logic.
 */
export {
  replayCounterexample,
  type ReplayCounterexampleRequest,
  type ReplayCounterexampleOptions,
} from "./orchestrator/replay.js";

/**
 * The Comparison Engine (task 14.1, design Component 4). PURE LOGIC that pairs
 * each property's LOCKED Predicted_Result (read back via the task-7 lock so the
 * ORIGINALLY recorded value is used, R3.5) with its Actual_Result and
 * classifies the pairing into a `PropertyComparison`: `PREDICTION_MISMATCH`
 * exactly when a predicted PASS/FAIL and an actual PASS/FAIL disagree (R7.1,
 * R7.2), `confirmedBug` only when the actual verdict is FAIL with its
 * Counterexample attached (R7.3), `NOT_COMPARED_TIMEOUT` for timeouts (R7.4),
 * and `NOT_EXECUTED` for a predicted property with no PASS/FAIL actual result
 * (R7.5). {@link compareProperties} is the in-memory entry point;
 * {@link comparePropertiesFromLocks} layers the task-7 lock reader on top for
 * on-disk locks; {@link noActualResult} builds the NOT_EXECUTED placeholder. The
 * full Lantern_Report assembly is task 16, not here.
 */
export {
  compareProperty,
  compareProperties,
  comparePropertiesFromLocks,
  noActualResult,
  type ComparisonInput,
  type LockedComparisonInput,
} from "./comparison/index.js";

/**
 * The Revive loop copy-and-apply mechanism (task 15.1, R8.1, R8.2). Makes a
 * fresh COPY of the Target_Repo into a Target_Repo_Copy and applies each
 * Kiro-authored Fix_Task ONLY to that copy, leaving the original Target_Repo
 * byte-for-byte unchanged ("the original is sacred"). {@link applyFixesToCopy}
 * is the entry point: it guards every Fix_Task's `appliesTo` === "Target_Repo_Copy"
 * BEFORE any filesystem work, copies the original (read-only), and writes each
 * {@link FixApplication}'s concrete {@link FileEdit}s confined under the copy
 * root so no write can reach the original (R8.2 / R12.6). It performs NO
 * install/build/test and spawns NO process — re-execution against the copy and
 * Property_Transition classification are the next subtask (15.2,
 * `apply_fixes_and_reexecute`). {@link copyTargetRepo} exposes just the copy
 * step; {@link cleanupTargetRepoCopy} removes a copy when done.
 */
export {
  applyFixesToCopy,
  copyTargetRepo,
  cleanupTargetRepoCopy,
  assertAppliesToCopy,
  type FileEdit,
  type FixApplication,
  type ApplyFixesResult,
  type ApplyFixesOptions,
} from "./revive/apply-fixes.js";

/**
 * The Revive loop re-execute-after-fix + Property_Transition (task 15.2, R8.3–
 * R8.7). {@link applyFixesAndReexecute} copies the Target_Repo, applies each
 * Fix_Task to the copy (reusing {@link applyFixesToCopy}), re-executes the SAME
 * Correctness_Properties against the fixed copy via {@link executeProperties}
 * (targetRepoRef = copy, phase = "post_fix", R8.3), and pairs each property's
 * caller-supplied Pre_Fix_Result with its just-produced Post_Fix_Result (R8.4).
 * {@link classifyTransition} is the PURE decision table mapping the (pre, post)
 * verdict pair to a {@link PropertyTransition}: FAIL→PASS = FIXED, FAIL→FAIL =
 * NOT_RESOLVED (R8.6), PASS→FAIL = REGRESSION (R8.7), PASS→PASS = STILL_PASSING.
 * A property whose pre- or post-fix result is a non-verdict outcome gets no
 * fabricated transition and is reported in `skippedPropertyIds`. The execution
 * runs through the SAME Safety Gate → Isolated_Runner seam (a fake runner is
 * injectable via `options.execute`), so no host execution/fallback is
 * introduced.
 */
export {
  applyFixesAndReexecute,
  classifyTransition,
  type ApplyFixesAndReexecuteRequest,
  type ApplyFixesAndReexecuteOptions,
  type ApplyFixesAndReexecuteResult,
  type PropertyFixOutcome,
} from "./revive/apply-fixes-reexecute.js";

/**
 * Lantern_Report assembly (task 16.1, design Component 4). PURE LOGIC that turns
 * the Comparison Engine's `PropertyComparison[]` plus the recorded
 * `ObservedDeviation[]` into a single `LanternReport`: exactly one comparison
 * per evaluated property, each carrying its Predicted_Result/Actual_Result
 * (R9.2) with Counterexamples for Confirmed_Bugs (R9.3) and Property_Transitions
 * (R9.5) riding along on `actual`/`transition`; the Observed_Deviations listed
 * as-is and joinable to their property via {@link describeDeviation} (R9.4); and
 * explicit `noConfirmedBug` (R9.6) / `noObservedDeviation` (R9.7) indications.
 * {@link assembleLanternReport} is the plain entry point;
 * {@link assembleLanternReportTimed} additionally MEASURES generation against
 * the configured report-generation limit (read from `LimitsConfig`, never a
 * literal, R9.1). {@link counterexampleOf} reads a Confirmed_Bug's Counterexample
 * off `actual`; an injectable {@link ReportClock} makes timing/timestamps
 * deterministic for the timed test (task 16.3). It executes nothing and never
 * touches the host.
 */
export {
  assembleLanternReport,
  assembleLanternReportTimed,
  counterexampleOf,
  describeDeviation,
  SYSTEM_REPORT_CLOCK,
  type ReportClock,
  type AssembleLanternReportOptions,
  type TimedLanternReport,
} from "./report/index.js";

/**
 * The MCP transport + tool wiring (tasks 10.1, 11.1, 15.2, 20). Exposes the
 * MCP_Server over the MCP TypeScript SDK and registers four tools:
 * `execute_properties`, `replay_counterexample`, `apply_fixes_and_reexecute`,
 * and `lock_prediction` (the prediction lock, R3.4/R3.5), whose handlers
 * delegate to {@link executeProperties}, {@link replayCounterexample},
 * {@link applyFixesAndReexecute}, and {@link lockPrediction} respectively.
 * {@link createMcpServer} builds the configured server (transport-agnostic, for
 * tests); {@link startStdioServer} connects it to the stdio transport so a local
 * Kiro_Power can launch it as a subprocess (see src/bin/server.ts).
 */
export {
  createMcpServer,
  startStdioServer,
  type CreateMcpServerOptions,
} from "./mcp-server.js";

/**
 * Verbatim tool-result persistence (change 2). {@link writeToolResult} writes a
 * tool's exact result to `<specRoot>/results/<utc-stamp>-<tool>.json` (creating
 * `results/` if missing) and returns the absolute path;
 * {@link utcStampForFilename} derives the filesystem-safe, sortable UTC stamp.
 */
export {
  writeToolResult,
  utcStampForFilename,
  RESULTS_DIR,
} from "./results/persist.js";

/**
 * Spec-derivation of CorrectnessProperty objects (change 1). When a `specRoot`
 * is given and the `properties`/`property` argument is omitted, the executing
 * tools call {@link deriveProperties} / {@link deriveProperty} to reconstruct
 * the properties from `claims.json` + the `properties/` test files (honest
 * `kind: "function"`), so the caller never hand-writes them.
 */
export {
  deriveProperties,
  deriveProperty,
  type DeriveCode,
  type DeriveIssue,
  type DeriveResult,
  type DeriveOneResult,
} from "./spec-derive/index.js";

/**
 * The line-ending-preserving unified-diff builder (change 4). Used by
 * {@link applyFixesToCopy} to compute the REAL diff of applied edits without
 * normalizing CRLF/LF.
 */
export {
  unifiedDiffForFile,
  splitLinesPreservingEndings,
  diffPathFor,
} from "./revive/unified-diff.js";

/**
 * The `compare_predictions` tool (change 3). {@link comparePredictions} runs the
 * Comparison Engine against a persisted execution result, reading predicted
 * verdicts ONLY from the locks, optionally grouping symptoms under a root cause
 * and counting lies per root cause, and writes `<specRoot>/comparison.json`.
 */
export {
  comparePredictions,
  extractActualResults,
  type ComparePredictionsRequest,
  type ComparePredictionsResult,
  type ComparePredictionsSummary,
  type RootCauseGroup,
} from "./compare-predictions/index.js";
