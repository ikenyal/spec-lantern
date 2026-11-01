# Implementation Plan: spec-lantern

## Overview

This plan builds spec-lantern — the Kiro_Power, the MCP_Server with a local rootless Podman Isolated_Runner, and the Lantern_Report_UI plus a static Hosted_Demo — in TypeScript, driven by the design document. The design specifies a TypeScript/React stack (fast-check + Vitest for property-based testing, jsdom + @testing-library/react for component rendering, rootless Podman + Verdaccio for isolation, the MCP TypeScript SDK, and AWS S3 + CloudFront for the static demo), so all tasks are in TypeScript.

**Conceptual model.** Reverse-engineering a spec, analyzing Observed_Deviations, extracting Claims into Correctness_Properties, authoring property-based tests, and recording Predicted_Results are performed by **Kiro itself at authoring time**, guided by the Kiro_Power steering — they are not implemented as a deterministic "repo analyzer / extractor / deviation engine" in code. The codebase's responsibilities around those artifacts are only to (a) **DEFINE** the on-disk artifact formats Kiro produces (Claims, Correctness_Properties as executable test files, Predicted_Results, Observed_Deviations), (b) **VALIDATE** those artifacts, and (c) **LOCK** predictions before execution so they cannot change once execution begins. Execution, comparison, the Revive loop, report assembly, and the UI remain real code.

**Sequencing is a walking skeleton first.** The earliest end-to-end slice proves the "execute, don't trust" path on the thinnest possible vertical: setup → artifact formats → a minimal Kiro_Power → a minimal local rootless Podman runner → execute exactly ONE property (the monthly-ordering claim whose comment says "Reverse to have most recent month first") against the **writing-tracker** reference Target_Repo and observe a **FAIL** with a Counterexample. Only after the skeleton is green does the plan add prediction locking, the full two-phase network topology hardening, the Comparison Engine, Lantern_Report assembly, the Revive loop, the UI, and the static Hosted_Demo — each building incrementally on the skeleton. The writing-tracker full end-to-end wiring plus its optional e2e test close the plan as MVP completion, now that the skeleton has already proved the core path.

The AWS Fargate execution runner is Future Work and is explicitly deferred — no task implements it. The static Hosted_Demo (no runner, no execution surface) is in scope.

Property-based tests use fast-check + Vitest, each implementing exactly one Correctness Property, running a minimum of 100 iterations, and tagged `Feature: spec-lantern, Property {n}: {property_text}`. Test sub-tasks are marked optional with `*`; core implementation tasks are not. The four safety-related test tasks (safety-gate decisions, negative boundary-escape, phase ordering + network policy, and the runner-dispatch/install-topology smoke test) are **required** because host safety is the product's core guarantee.

## Tasks

- [x] 1. Set up project structure, shared types, and testing framework
  - Create the TypeScript monorepo/package layout for the three deliverables (`kiro-power/`, `mcp-server/`, `ui/`) with a shared `types` module
  - Configure Vitest (jsdom environment available) and install fast-check, @testing-library/react, jsdom
  - Set up lint/build/test scripts; add a Vitest config that enforces a minimum of 100 iterations for fast-check runs
  - _Requirements: foundational for all_

- [x] 2. Define the artifact formats Kiro produces
  - [x] 2.1 Define the serializable JSON domain types and configurable limits
    - Define `Verdict`, `Claim` (with `unverifiable`), `ObservedDeviation`, `CorrectnessProperty` (with `kind` and `embeddedComponentLogic`), `PredictedResult`, `ExecutionContext`, `Counterexample`
    - Define the `ActualResult` discriminated union with outcomes `VERDICT`, `TIMEOUT`, `EXECUTION_ERROR`, `RUNNER_UNAVAILABLE`, `SAFETY_VIOLATION` (timeouts and execution errors are never encoded as PASS/FAIL)
    - Define `PropertyExecutionRequest`, `PropertyExecutionResult`, `FixTask`, `PropertyTransition`, `PropertyComparison`, `LanternReport`
    - Define `LimitsConfig` and `DEFAULT_LIMITS` (executionTimeoutSeconds=30, reportGenerationLimitSeconds=10, uiRenderLimitSeconds=3) read from configuration, not hard-coded constants; ensure the `TIMEOUT` outcome carries the limit actually in effect (`limitSeconds`)
    - _Requirements: 5.5, 5.6, 5.7, 5.8, 5.9, 6.1, 7.3, 7.4, 7.5, 8.1, 8.4, 8.5, 9.1, 9.2, 10.2, 12.4_

  - [x] 2.2 Define the on-disk artifact schemas and the property-test-file convention
    - Define concrete on-disk formats that Kiro writes and downstream tooling consumes: a JSON schema for Claims (each carrying non-empty `sourceFile`/`commentRef` and an optional `unverifiable.reason`), a JSON schema for Observed_Deviations (each referencing its originating Claim, allowing an undeterminable marker and the empty-list case), a JSON schema for Predicted_Results (verdict + pre-execution timestamp), and the executable property-test-file convention for Correctness_Properties (one test file per expressible Claim, tagged `Feature: spec-lantern, Property {n}`, terminating with exactly PASS or FAIL)
    - Define the on-disk layout tying a Claim id → its Correctness_Property test file → its Predicted_Result so a 1:1 mapping is expressible on disk
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 3.1, 3.4, 3.6, 4.1, 4.4_

- [x] 3. Author the Kiro_Power artifacts (POWER.md + steering)
  - [x] 3.1 Write POWER.md and steering that produces the artifact formats and delegates execution
    - Author the steering that drives Kiro to Reverse_Engineer the spec (EARS requirements + a design whose Correctness_Properties section has at least one property per requirement), record each comment-described behavior as a distinct referenced Claim, report unreadable / no-analyzable-source repos without a partial spec, build the Observed_Deviations list (including undeterminable entries and the empty-list case), convert each expressible Claim 1:1 into a Correctness_Property test file while recording inexpressible Claims as unverifiable with a reason, record an immutable Predicted_Result before execution, handle embedded component logic (props-driven → `component_rendered`; internally-fetching → unverifiable), and generate Fix_Tasks for Confirmed_Bugs
    - Write everything in the on-disk artifact formats from task 2.2 and delegate ALL execution to the MCP_Server tools (`execute_properties`, `apply_fixes_and_reexecute`, `replay_counterexample`) and prediction locking to the lock tool
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 3.1, 3.4, 3.6, 4.1, 4.4, 8.1, 8.2_

- [ ] 4. Walking skeleton — execute ONE property end-to-end against writing-tracker and observe a FAIL
  - [x] 4.1 Author the minimal walking-skeleton artifacts for the monthly-ordering claim
    - Using the formats from task 2.2 and the steering from task 3.1, hand-produce the single Claim for writing-tracker's monthly-ordering behavior (comment: "Reverse to have most recent month first"), its one Correctness_Property test file asserting most-recent-month-first, and a Predicted_Result of PASS (the read-only, comment-trusting prediction)
    - _Requirements: 1.3, 3.1, 3.4_

  - [x] 4.2 Build the minimal local rootless Podman runner for one property
    - Create a rootless Podman container that mounts only the writing-tracker working directory, installs dependencies, and runs the single Correctness_Property test file via Vitest inside the container; return a VERDICT (PASS/FAIL) with a Counterexample on FAIL
    - Keep topology minimal for now (full two-phase network hardening is task 9); the only requirement here is that target code runs in the container, never the host
    - _Requirements: 5.1, 5.3, 5.5, 5.6, 12.1_

  - [-] 4.3 Wire the thinnest execute path and surface the FAIL
    - Connect skeleton artifact (4.1) → minimal runner (4.2): dispatch the one property into the runner, execute it against writing-tracker, and surface the resulting FAIL (oldest-month-first) with its Counterexample, proving execution contradicts the comment-trusting PASS prediction
    - _Requirements: 5.1, 5.5, 5.6_

  - [ ]* 4.4 Write a walking-skeleton smoke test for the single-property FAIL
    - Assert the one property executes inside the runner (not the host) and yields FAIL with a Counterexample for the writing-tracker monthly-ordering claim
    - _Requirements: 5.1, 5.6, 12.1_

- [ ] 5. Checkpoint - Ensure the walking skeleton is green
  - Ensure all tests pass and the single-property FAIL is reproducible end-to-end, ask the user if questions arise.

- [ ] 6. Build the artifact Validator
  - [ ] 6.1 Validate Claims, 1:1 Claim→property mapping, and unverifiable Claims
    - Validate that each Claim carries non-empty `sourceFile`/`commentRef`; that every expressible Claim maps 1:1 to exactly one Correctness_Property test file; and that every unverifiable Claim carries a non-empty reason and emits no property
    - _Requirements: 1.3, 3.1, 3.6_

  - [ ] 6.2 Validate Observed_Deviations references and the empty-list case
    - Validate that each Observed_Deviation references a valid originating Claim and carries claimed behavior plus current behavior or an undeterminable marker; validate the empty-list case when no difference is found; validate that an undeterminable entry retains all other evaluated Claims
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ] 6.3 Validate that each property test file is runnable and terminates PASS/FAIL
    - Validate that every Correctness_Property test file is runnable and terminates with exactly one of PASS or FAIL
    - _Requirements: 3.2_

  - [ ]* 6.4 Write property tests for the Validator (artifact-shape properties)
    - **Property 1: Every identified behavior yields an EARS criterion** — Feature: spec-lantern, Property 1
    - **Property 2: Every requirement has at least one correctness property** — Feature: spec-lantern, Property 2
    - **Property 3: Each behavior comment becomes a distinct, referenced Claim** — Feature: spec-lantern, Property 3
    - **Property 4: Observed_Deviations are complete and reference their Claim** — Feature: spec-lantern, Property 4
    - **Property 5: No differences yields an empty Observed_Deviations list** — Feature: spec-lantern, Property 5
    - **Property 6: Claim-to-property mapping is exactly one-to-one** — Feature: spec-lantern, Property 6
    - **Property 8: Props-driven embedded component logic yields a rendered-output property; internally-fetching components are recorded unverifiable** — Feature: spec-lantern, Property 8
    - **Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 3.1, 3.6, 4.1, 4.4**

  - [ ]* 6.5 Write unit tests for unverifiable Claims and malformed-artifact rejection
    - Assert the unverifiable record and reason for an inexpressible Claim; assert the validator rejects a Claim missing `sourceFile`/`commentRef`, a Claim with zero or multiple property files, and a deviation with a dangling Claim reference
    - _Requirements: 1.3, 3.1, 3.6_

- [ ] 7. Build the prediction-lock MCP tool
  - [ ] 7.1 Lock Predicted_Results before execution
    - Expose an MCP tool that computes a content hash + timestamp over each Predicted_Result and the Correctness_Property artifact it refers to, and persists a lock so the prediction cannot change once execution begins; later comparison reads the locked value
    - _Requirements: 3.4, 3.5_

  - [ ]* 7.2 Write a property test for prediction immutability
    - **Property 7: Predicted_Result is a verdict recorded before execution and is immutable** — Feature: spec-lantern, Property 7
    - **Validates: Requirements 3.4, 3.5**

- [ ] 8. Harden the Safety Gate and runner boundary contract
  - [ ] 8.1 Implement the Safety Gate (pre-execution classification)
    - Classify every Property_Execution_Request and fix-application request; accept only runner-targeted operations
    - Reject any operation that would run a Target_Repo process, script, or build step in the host process or host shell before anything runs, report a `SAFETY_VIOLATION`, and leave host filesystem and process state unchanged
    - _Requirements: 5.2, 12.1, 12.4_

  - [ ] 8.2 Define the Isolated_Runner interface and no-fallback invariant
    - Define the runner contract (mount only the target working directory, confine file access to the boundary) as the single execution target, generalizing the minimal skeleton runner from task 4.2
    - On runner-create failure or unavailability, abort with a `RUNNER_UNAVAILABLE` error identifying the reason and never fall back to host execution
    - _Requirements: 5.8, 12.5, 12.6_

  - [ ] 8.3 Write property tests for safety-gate decisions
    - **Property 28: Accepted executions always target the runner, never the host** — Feature: spec-lantern, Property 28
    - **Property 29: Host-bound requests are rejected before any code runs** — Feature: spec-lantern, Property 29
    - **Property 30: Runner unavailability aborts without host fallback** — Feature: spec-lantern, Property 30
    - **Validates: Requirements 5.2, 5.8, 12.1, 12.4, 12.5**

  - [ ] 8.4 Write targeted negative safety tests
    - Attempt to escape the runner boundary and assert the host filesystem and process state remain unchanged
    - _Requirements: 12.4, 12.5, 12.6_

- [ ] 9. Harden the two-phase network topology and runner lifecycle (local rootless Podman)
  - [ ] 9.1 Construct the install-phase network topology
    - Build the internal-only Podman network, the install container (package manager with `--ignore-scripts`, no direct outbound route), and the single outbound-capable registry-proxy (Verdaccio) container; point the install container's registry at the proxy
    - Tear down the install network and proxy before the test phase begins
    - _Requirements: 5.3, 5.4, 12.2_

  - [ ] 9.2 Construct the test-phase execution with no network
    - Run the Test_Execution_Phase with all inbound and outbound network disabled for the entire phase; ensure the install phase completes first
    - _Requirements: 5.4, 12.3_

  - [ ]* 9.3 Write property tests for phase ordering and network policy
    - **Property 13: Install phase precedes test phase** — Feature: spec-lantern, Property 13
    - **Property 33: Install-phase topology permits only the package registry with scripts disabled** — Feature: spec-lantern, Property 33
    - **Property 34: Test-phase network is fully disabled for the whole phase** — Feature: spec-lantern, Property 34
    - **Property 35: Target file access is confined to the runner boundary** — Feature: spec-lantern, Property 35
    - **Validates: Requirements 5.4, 12.2, 12.3, 12.6**

- [ ] 10. Implement the MCP_Server execution orchestrator and `execute_properties` tool
  - [ ] 10.1 Wire the MCP transport and the `execute_properties` tool
    - Expose the MCP tool using the MCP TypeScript SDK; route requests through the Safety Gate (task 8) then the runner lifecycle (task 9)
    - Execute each property against the Target_Repo inside the runner; return VERDICT (PASS/FAIL) on normal completion
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [ ] 10.2 Implement Counterexample, timeout, and execution-error outcomes
    - On FAIL, return a Counterexample with triggering input values and observed output
    - On exceeding the configured execution timeout (default 30s), terminate and return a `TIMEOUT` outcome carrying the limit in effect, with no PASS/FAIL
    - On uncaught error / load failure, return an `EXECUTION_ERROR` with a reason and no PASS/FAIL
    - _Requirements: 5.6, 5.7, 5.9_

  - [ ] 10.3 Record Execution_Context per execution
    - Seed fast-check from a recorded Random_Seed and pin timezone and Fixed_Current_Time; attach the Execution_Context to each Counterexample
    - _Requirements: 6.1, 6.2_

  - [ ]* 10.4 Write property tests for execution outcomes and reproducibility context
    - **Property 10: Normal completion returns exactly one verdict** — Feature: spec-lantern, Property 10
    - **Property 11: Every FAIL carries a Counterexample with its Execution_Context** — Feature: spec-lantern, Property 11
    - **Property 31: Target code that errors or fails to load yields an execution error** — Feature: spec-lantern, Property 31
    - **Property 32: Timeouts terminate with no verdict** — Feature: spec-lantern, Property 32
    - **Validates: Requirements 3.2, 5.5, 5.6, 5.7, 5.9, 6.1, 6.2**

  - [ ] 10.5 Write an integration smoke test for runner dispatch and install topology
    - Assert a request is dispatched into the rootless Podman runner (not the host); bring up the install-phase internal-only network + proxy and assert the install container reaches the proxy but has no direct outbound internet route
    - _Requirements: 5.1, 5.3, 12.2_

- [ ] 11. Implement Counterexample replay (`replay_counterexample` tool)
  - [ ] 11.1 Implement replay from a recorded Execution_Context
    - Re-run a property with its recorded Random_Seed, timezone, and Fixed_Current_Time and produce an Actual_Result equal to the original
    - _Requirements: 6.3_

  - [ ]* 11.2 Write property test for replay reproducibility
    - **Property 12: Replay with the recorded Execution_Context reproduces the result** — Feature: spec-lantern, Property 12
    - **Validates: Requirements 6.3**

- [ ] 12. Implement jsdom component rendering under a Controllable_Clock
  - [ ] 12.1 Render props-driven embedded component logic
    - Render a props-driven React component in jsdom with mocked data injected via props and supply a Controllable_Clock (fake timers pinned to Fixed_Current_Time plus fixed `TZ`)
    - Evaluate the `component_rendered` Correctness_Property authored by Kiro against the rendered output; for internally-fetching components (recorded unverifiable by the Kiro_Power) render nothing
    - _Requirements: 4.2, 4.3_

  - [ ]* 12.2 Write property tests for component rendering determinism
    - **Property 9: Rendering under a fixed clock is deterministic** — Feature: spec-lantern, Property 9
    - **Validates: Requirements 4.3**

  - [ ]* 12.3 Write an integration test for jsdom rendering with injected data
    - Render a representative props-driven component with mocked data via props and assert the render used the injected data; add a negative case asserting an internally-fetching component is recorded unverifiable
    - _Requirements: 4.2, 3.6_

- [ ] 13. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Implement the Comparison Engine
  - [ ] 14.1 Pair predictions with actual results and classify
    - Pair Predicted_Result (read from the lock, task 7) with Actual_Result when both PASS/FAIL exist and flag inequality as a prediction mismatch
    - Classify FAIL as a Confirmed_Bug and attach its Counterexample; exclude timeouts (mark NOT_COMPARED_TIMEOUT); mark predicted-only properties NOT_EXECUTED
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 14.2 Write property tests for the comparison logic
    - **Property 14: Prediction mismatch is flagged exactly when predicted differs from actual** — Feature: spec-lantern, Property 14
    - **Property 15: FAIL classifies a Confirmed_Bug with its Counterexample; non-FAIL does not** — Feature: spec-lantern, Property 15
    - **Property 16: Timeout outcomes are excluded from comparison** — Feature: spec-lantern, Property 16
    - **Property 17: Predicted-only properties are marked not executed** — Feature: spec-lantern, Property 17
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**

- [ ] 15. Implement the Revive loop (Fix_Tasks, Target_Repo_Copy, Property_Transition)
  - [ ] 15.1 Apply fixes to the Target_Repo_Copy only
    - Apply each Kiro-authored Fix_Task only to the Target_Repo_Copy, leaving the original Target_Repo byte-for-byte unchanged
    - _Requirements: 8.1, 8.2_

  - [ ] 15.2 Implement `apply_fixes_and_reexecute` and record Property_Transition
    - Re-execute the same Correctness_Properties against the Target_Repo_Copy in the runner; record Pre_Fix_Result and Post_Fix_Result
    - Build the Property_Transition classification: FIXED (FAIL→PASS), NOT_RESOLVED (FAIL→FAIL), REGRESSION (PASS→FAIL), STILL_PASSING (PASS→PASS)
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7_

  - [ ]* 15.3 Write property tests for the Revive loop
    - **Property 18: Every Confirmed_Bug produces at least one Fix_Task** — Feature: spec-lantern, Property 18
    - **Property 19: Fixes modify only the copy, never the original** — Feature: spec-lantern, Property 19
    - **Property 20: Both pre-fix and post-fix results are recorded on re-execution** — Feature: spec-lantern, Property 20
    - **Property 21: Property_Transition classification matches the pre/post pair** — Feature: spec-lantern, Property 21
    - **Validates: Requirements 8.1, 8.2, 8.4, 8.5, 8.6, 8.7**

  - [ ]* 15.4 Write an integration test for re-execution against the copy
    - After fixes are applied to the Target_Repo_Copy, re-execute the same property set against the copy inside the runner
    - _Requirements: 8.3_

- [ ] 16. Implement Lantern_Report assembly
  - [ ] 16.1 Assemble the Lantern_Report
    - Build a report listing exactly one comparison per evaluated property (with Predicted_Result and Actual_Result), Counterexamples for Confirmed_Bugs, Observed_Deviations with their associated property and predicted-vs-actual difference, and Property_Transitions
    - Set explicit no-Confirmed_Bug and no-Observed_Deviation indications when empty; produce within the configured report-generation limit (default 10s)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [ ]* 16.2 Write property tests for report assembly
    - **Property 22: The report lists every evaluated property with predicted and actual** — Feature: spec-lantern, Property 22
    - **Property 23: The report includes counterexamples, deviations, and transitions it was given** — Feature: spec-lantern, Property 23
    - **Property 24: Empty collections produce explicit indications** — Feature: spec-lantern, Property 24
    - **Validates: Requirements 9.2, 9.3, 9.4, 9.5, 9.6, 9.7**

  - [ ]* 16.3 Write a timed unit test for report generation limit
    - Assert the report is produced within the configured report-generation limit (default 10s) of comparison completion
    - _Requirements: 9.1_

- [ ] 17. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 18. Implement the Lantern_Report_UI
  - [ ] 18.1 Render property rows with predicted vs actual and mismatch indicator
    - Render each Correctness_Property row with Predicted_Result and Actual_Result positioned adjacently in the same row; render all entries within the configured UI render limit (default 3s)
    - Apply a visual mismatch indicator exactly on rows where Predicted differs from Actual, absent where they match
    - _Requirements: 10.1, 10.2, 10.3_

  - [ ] 18.2 Render counterexamples, transitions, and empty/missing states
    - Render the Counterexample on Confirmed_Bug rows, or an "unavailable" indication when missing; render Pre_Fix_Result and Post_Fix_Result on Property_Transition rows
    - Show a "no report exists" message when no Lantern_Report is available
    - _Requirements: 10.4, 10.5, 10.6, 10.7_

  - [ ]* 18.3 Write property tests for UI rendering
    - **Property 25: Each rendered row shows predicted and actual adjacently** — Feature: spec-lantern, Property 25
    - **Property 26: The UI mismatch indicator is present exactly on mismatched rows** — Feature: spec-lantern, Property 26
    - **Property 27: The UI renders counterexamples and transitions it is given** — Feature: spec-lantern, Property 27
    - **Validates: Requirements 10.1, 10.3, 10.4, 10.5**

  - [ ]* 18.4 Write unit tests for UI empty/missing states and render timing
    - Assert the Counterexample-unavailable indication, the no-report message, and that all entries render within the configured UI render limit (default 3s)
    - _Requirements: 10.2, 10.6, 10.7_

- [ ] 19. Implement the static Hosted_Demo (S3 + CloudFront)
  - [ ] 19.1 Export pre-generated sample Lantern_Reports as static assets
    - Add an export step that serializes one or more pre-generated sample Lantern_Reports (produced by the local pipeline) to static JSON/assets the UI loads client-side; the demo contains no runner and executes no Target_Repo code
    - _Requirements: 11.2_

  - [ ] 19.2 Build the static site hosting and infrastructure
    - Configure the S3 + CloudFront static hosting (infrastructure-as-code) so the UI and sample assets are reachable over the public internet with no local install, reusing the same Lantern_Report_UI views
    - _Requirements: 11.1, 11.3_

  - [ ]* 19.3 Write an integration test for the Hosted_Demo
    - Assert the static demo is reachable without local install, serves pre-generated sample reports as static assets (no runner/no execution), and exposes the predicted-vs-actual, Counterexample, and Property_Transition views
    - _Requirements: 11.1, 11.2, 11.3_

- [ ] 20. Wire the full end-to-end pipeline on the writing-tracker reference Target_Repo (MVP completion)
  - [ ] 20.1 Connect all components into the full pipeline
    - Wire Kiro_Power artifacts → Validator → prediction lock → Safety Gate → runner lifecycle → execution outcomes → Comparison Engine → Revive loop → Lantern_Report → UI, extending the walking skeleton to the full writing-tracker property set, and produce a pre-generated writing-tracker report for the Hosted_Demo
    - Demonstrate at least one Confirmed_Bug with a Counterexample and at least one FIXED (FAIL→PASS) Property_Transition applied to the Target_Repo_Copy and re-executed, with host-safety invariants holding throughout
    - _Requirements: 5.1, 7.1, 8.3, 9.1, 10.1, 11.2, 12.1_

  - [ ]* 20.2 Write an end-to-end integration test for the writing-tracker pipeline
    - Run the full pipeline against writing-tracker and assert a Confirmed_Bug with Counterexample, a FAIL→PASS transition, and that no Target_Repo code ran on the host
    - _Requirements: 5.1, 8.3, 12.1_

- [ ] 21. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- **Artifacts vs code:** reverse-engineering, deviation analysis, Claim→Property extraction, property-test authoring, and prediction are produced by Kiro at authoring time under the Kiro_Power steering (tasks 3, 4.1, 20.1). The code only defines the artifact formats (task 2), validates them (task 6), locks predictions (task 7), executes (tasks 8–12), compares/revives/reports (tasks 14–16), and renders (tasks 18–19). No task implements a repo-analyzer / extractor / deviation engine in code.
- **Walking skeleton:** tasks 2–5 form the first vertical slice — one property executed against writing-tracker observing a real FAIL — proving the execute-don't-trust path before any further hardening.
- Tasks marked with `*` are optional (test-related) and can be skipped for a faster MVP, **except** the four safety-related test tasks (8.3, 8.4, 9.3, 10.5), which are required because host safety is the product's core guarantee.
- Each task references the specific requirements and/or Correctness Properties it implements for traceability.
- Property-based tests use fast-check + Vitest, implement exactly one Correctness Property each, run a minimum of 100 iterations, and are tagged `Feature: spec-lantern, Property {n}: {property_text}`.
- Checkpoints provide incremental validation at natural boundaries (skeleton green, pure logic/runner/safety, Revive/report, UI/demo).
- The AWS Fargate execution runner is Future Work and is intentionally NOT included as a task. The static Hosted_Demo (no runner, no execution surface) is in scope and is implemented in task 19.
- The two overriding safety invariants — no host execution and no host fallback — are implemented in tasks 8–9 and verified by the required safety property and negative tests (8.3, 8.4, 9.3, 10.5).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["2.2"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["4.1", "4.2"] },
    { "id": 4, "tasks": ["4.3"] },
    { "id": 5, "tasks": ["4.4", "6.1", "6.2", "6.3", "7.1", "8.1", "8.2"] },
    { "id": 6, "tasks": ["6.4", "6.5", "7.2", "8.3", "8.4", "9.1", "9.2"] },
    { "id": 7, "tasks": ["9.3", "10.1"] },
    { "id": 8, "tasks": ["10.2", "10.3"] },
    { "id": 9, "tasks": ["10.4", "10.5", "11.1", "12.1"] },
    { "id": 10, "tasks": ["11.2", "12.2", "12.3", "14.1"] },
    { "id": 11, "tasks": ["14.2", "15.1"] },
    { "id": 12, "tasks": ["15.2"] },
    { "id": 13, "tasks": ["15.3", "15.4", "16.1"] },
    { "id": 14, "tasks": ["16.2", "16.3", "18.1", "18.2"] },
    { "id": 15, "tasks": ["18.3", "18.4", "19.1"] },
    { "id": 16, "tasks": ["19.2"] },
    { "id": 17, "tasks": ["19.3", "20.1"] },
    { "id": 18, "tasks": ["20.2"] }
  ]
}
```
