# Implementation Plan: spec-lantern

## Overview

This plan builds spec-lantern — the Kiro_Power, the MCP_Server with a local rootless Podman Isolated_Runner, and the Lantern_Report_UI plus a static Hosted_Demo — in TypeScript, driven by the design document. The design specifies a TypeScript/React stack (fast-check + Vitest for property-based testing, jsdom + @testing-library/react for component rendering, rootless Podman + Verdaccio for isolation, the MCP TypeScript SDK, and AWS S3 + CloudFront for the static demo), so all tasks are in TypeScript.

Sequencing is driven by the solo build with a hard deadline of December 4, 2026. The ordering front-loads the shared data models and the pure-logic engines (extraction, comparison, transition, report assembly) so property-based tests can run cheaply against mocks, then layers the runner and safety boundary, then the Revive loop, then the UI, and finally the end-to-end pipeline on the reference Target_Repo **writing-tracker** that is the MVP keystone. The AWS Fargate execution runner is Future Work and is explicitly deferred — no task implements it. The static Hosted_Demo (no runner, no execution surface) is in scope and is included.

Property-based tests use fast-check + Vitest, each implementing exactly one Correctness Property, running a minimum of 100 iterations, and tagged `Feature: spec-lantern, Property {n}: {property_text}`. Test sub-tasks are marked optional with `*`; core implementation tasks are not.

## Tasks

- [ ] 1. Set up project structure, shared types, and testing framework
  - Create the TypeScript monorepo/package layout for the three deliverables (`kiro-power/`, `mcp-server/`, `ui/`) with a shared `types` module
  - Configure Vitest (jsdom environment available) and install fast-check, @testing-library/react, jsdom
  - Set up lint/build/test scripts; add a Vitest config that enforces a minimum of 100 iterations for fast-check runs
  - _Requirements: foundational for all_

- [ ] 2. Define shared data models and configurable limits
  - [ ] 2.1 Implement the serializable JSON domain types
    - Define `Verdict`, `Claim` (with `unverifiable`), `ObservedDeviation`, `CorrectnessProperty` (with `kind` and `embeddedComponentLogic`), `PredictedResult`, `ExecutionContext`, `Counterexample`
    - Define the `ActualResult` discriminated union with outcomes `VERDICT`, `TIMEOUT`, `EXECUTION_ERROR`, `RUNNER_UNAVAILABLE`, `SAFETY_VIOLATION` (timeouts and execution errors are never encoded as PASS/FAIL)
    - Define `PropertyExecutionRequest`, `PropertyExecutionResult`, `FixTask`, `PropertyTransition`, `PropertyComparison`, `LanternReport`
    - _Requirements: 5.5, 5.6, 5.7, 5.8, 5.9, 6.1, 7.3, 7.4, 7.5, 8.1, 8.4, 8.5, 9.2, 12.4_

  - [ ] 2.2 Implement `LimitsConfig` with tunable defaults
    - Define `LimitsConfig` and `DEFAULT_LIMITS` (executionTimeoutSeconds=30, reportGenerationLimitSeconds=10, uiRenderLimitSeconds=3) read from configuration, not hard-coded constants
    - Ensure the `TIMEOUT` outcome carries the limit actually in effect (`limitSeconds`)
    - _Requirements: 5.7, 9.1, 10.2_

- [ ] 3. Implement the Kiro_Power reverse-engineering and extraction logic
  - [ ] 3.1 Implement repo analysis and spec generation
    - Walk a Target_Repo, parse TypeScript sources, and emit requirements where each identified behavior yields at least one EARS criterion and a design whose Correctness_Properties section has at least one property per requirement
    - Record each comment-described behavior as a distinct Claim carrying non-empty `sourceFile` and `commentRef`
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ] 3.2 Implement unreadable / no-analyzable-source handling
    - Report that reverse-engineering cannot proceed with a specific human-readable reason for an unreadable repo, and a "no analyzable TypeScript source found" message when none parse; write no partial spec in either case
    - _Requirements: 1.4, 1.5_

  - [ ]* 3.3 Write property tests for spec generation and claim extraction
    - **Property 1: Every identified behavior yields an EARS criterion** — Feature: spec-lantern, Property 1
    - **Property 2: Every requirement has at least one correctness property** — Feature: spec-lantern, Property 2
    - **Property 3: Each behavior comment becomes a distinct, referenced Claim** — Feature: spec-lantern, Property 3
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [ ]* 3.4 Write unit tests for unreadable / no-analyzable-source branches
    - Assert the specific failure report and that no partial spec is written for each branch
    - _Requirements: 1.4, 1.5_

- [ ] 4. Implement Observed_Deviations analysis
  - [ ] 4.1 Build the Observed_Deviations list
    - Produce one entry per claimed-vs-current difference, each referencing its originating Claim and carrying claimed behavior, current behavior (or an undeterminable marker), and a valid Claim reference
    - Produce an empty list when no difference is found; mark a Claim undeterminable when its behavior is absent/inaccessible while retaining all other evaluated Claims
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 4.2 Write property tests for Observed_Deviations
    - **Property 4: Observed_Deviations are complete and reference their Claim** — Feature: spec-lantern, Property 4
    - **Property 5: No differences yields an empty Observed_Deviations list** — Feature: spec-lantern, Property 5
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**

- [ ] 5. Implement Claim-to-Property extraction and immutable prediction
  - [ ] 5.1 Convert Claims into Correctness_Properties one-to-one
    - Generate exactly one Correctness_Property per expressible Claim referencing that distinct Claim; record inexpressible Claims as unverifiable with a non-empty reason and emit no property for them
    - Express each property as an executable test that terminates with exactly PASS or FAIL
    - _Requirements: 3.1, 3.2, 3.6_

  - [ ] 5.2 Record immutable Predicted_Result before execution
    - Record a PASS/FAIL Predicted_Result with a timestamp preceding execution; make it a no-op to change once execution begins so later comparison reads the original value
    - _Requirements: 3.4, 3.5_

  - [ ] 5.3 Implement the Kiro-side non-termination guard
    - Halt a Kiro-side property test that does not terminate within 60 seconds and record FAIL with a timeout reason
    - _Requirements: 3.3_

  - [ ]* 5.4 Write property tests for extraction and prediction
    - **Property 6: Claim-to-property mapping is exactly one-to-one** — Feature: spec-lantern, Property 6
    - **Property 7: Predicted_Result is a verdict recorded before execution and is immutable** — Feature: spec-lantern, Property 7
    - **Property 10: Normal completion returns exactly one verdict** (verdict shape at the extraction/logic level) — Feature: spec-lantern, Property 10
    - **Validates: Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 5.5**

  - [ ]* 5.5 Write unit tests for the 60s guard and inexpressible Claims
    - Drive the 60s non-termination guard with a mocked timer and assert halt-at-60s with FAIL-timeout
    - Assert the unverifiable record and reason for an inexpressible Claim
    - _Requirements: 3.3, 3.6_

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement the Safety Gate and runner boundary contract
  - [ ] 7.1 Implement the Safety Gate (pre-execution classification)
    - Classify every Property_Execution_Request and fix-application request; accept only runner-targeted operations
    - Reject any operation that would run a Target_Repo process, script, or build step in the host process or host shell before anything runs, report a `SAFETY_VIOLATION`, and leave host filesystem and process state unchanged
    - _Requirements: 5.2, 12.1, 12.4_

  - [ ] 7.2 Define the Isolated_Runner interface and no-fallback invariant
    - Define the runner contract (mount only the target working directory, confine file access to the boundary) as the single execution target
    - On runner-create failure or unavailability, abort with a `RUNNER_UNAVAILABLE` error identifying the reason and never fall back to host execution
    - _Requirements: 5.8, 12.5, 12.6_

  - [ ]* 7.3 Write property tests for safety-gate decisions
    - **Property 28: Accepted executions always target the runner, never the host** — Feature: spec-lantern, Property 28
    - **Property 29: Host-bound requests are rejected before any code runs** — Feature: spec-lantern, Property 29
    - **Property 30: Runner unavailability aborts without host fallback** — Feature: spec-lantern, Property 30
    - **Validates: Requirements 5.2, 5.8, 12.1, 12.4, 12.5**

  - [ ]* 7.4 Write targeted negative safety tests
    - Attempt to escape the runner boundary and assert the host filesystem and process state remain unchanged
    - _Requirements: 12.4, 12.5, 12.6_

- [ ] 8. Implement the two-phase network topology and runner lifecycle (local rootless Podman)
  - [ ] 8.1 Construct the install-phase network topology
    - Build the internal-only Podman network, the install container (package manager with `--ignore-scripts`, no direct outbound route), and the single outbound-capable registry-proxy (Verdaccio) container; point the install container's registry at the proxy
    - Tear down the install network and proxy before the test phase begins
    - _Requirements: 5.3, 5.4, 12.2_

  - [ ] 8.2 Construct the test-phase execution with no network
    - Run the Test_Execution_Phase with all inbound and outbound network disabled for the entire phase; ensure the install phase completes first
    - _Requirements: 5.4, 12.3_

  - [ ]* 8.3 Write property tests for phase ordering and network policy
    - **Property 13: Install phase precedes test phase** — Feature: spec-lantern, Property 13
    - **Property 33: Install-phase topology permits only the package registry with scripts disabled** — Feature: spec-lantern, Property 33
    - **Property 34: Test-phase network is fully disabled for the whole phase** — Feature: spec-lantern, Property 34
    - **Property 35: Target file access is confined to the runner boundary** — Feature: spec-lantern, Property 35
    - **Validates: Requirements 5.4, 12.2, 12.3, 12.6**

- [ ] 9. Implement the MCP_Server execution orchestrator and `execute_properties` tool
  - [ ] 9.1 Wire the MCP transport and the `execute_properties` tool
    - Expose the MCP tool using the MCP TypeScript SDK; route requests through the Safety Gate (task 7) then the runner lifecycle (task 8)
    - Execute each property against the Target_Repo inside the runner; return VERDICT (PASS/FAIL) on normal completion
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [ ] 9.2 Implement Counterexample, timeout, and execution-error outcomes
    - On FAIL, return a Counterexample with triggering input values and observed output
    - On exceeding the configured execution timeout (default 30s), terminate and return a `TIMEOUT` outcome carrying the limit in effect, with no PASS/FAIL
    - On uncaught error / load failure, return an `EXECUTION_ERROR` with a reason and no PASS/FAIL
    - _Requirements: 5.6, 5.7, 5.9_

  - [ ] 9.3 Record Execution_Context per execution
    - Seed fast-check from a recorded Random_Seed and pin timezone and Fixed_Current_Time; attach the Execution_Context to each Counterexample
    - _Requirements: 6.1, 6.2_

  - [ ]* 9.4 Write property tests for execution outcomes and reproducibility context
    - **Property 11: Every FAIL carries a Counterexample with its Execution_Context** — Feature: spec-lantern, Property 11
    - **Property 31: Target code that errors or fails to load yields an execution error** — Feature: spec-lantern, Property 31
    - **Property 32: Timeouts terminate with no verdict** — Feature: spec-lantern, Property 32
    - **Validates: Requirements 5.6, 5.7, 5.9, 6.1, 6.2**

  - [ ]* 9.5 Write an integration smoke test for runner dispatch and install topology
    - Assert a request is dispatched into the rootless Podman runner (not the host); bring up the install-phase internal-only network + proxy and assert the install container reaches the proxy but has no direct outbound internet route
    - _Requirements: 5.1, 5.3, 12.2_

- [ ] 10. Implement Counterexample replay (`replay_counterexample` tool)
  - [ ] 10.1 Implement replay from a recorded Execution_Context
    - Re-run a property with its recorded Random_Seed, timezone, and Fixed_Current_Time and produce an Actual_Result equal to the original
    - _Requirements: 6.3_

  - [ ]* 10.2 Write property test for replay reproducibility
    - **Property 12: Replay with the recorded Execution_Context reproduces the result** — Feature: spec-lantern, Property 12
    - **Validates: Requirements 6.3**

- [ ] 11. Implement jsdom component rendering under a Controllable_Clock
  - [ ] 11.1 Render props-driven embedded component logic
    - Render a props-driven React component in jsdom with mocked data injected via props and supply a Controllable_Clock (fake timers pinned to Fixed_Current_Time plus fixed `TZ`)
    - Mark embedded component logic and derive a `component_rendered` Correctness_Property asserting on rendered output; for internally-fetching components derive no property and record the Claim as unverifiable with a reason naming the internal data dependency
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 3.6_

  - [ ]* 11.2 Write property tests for component rendering determinism
    - **Property 8: Props-driven embedded component logic yields a rendered-output property; internally-fetching components are recorded unverifiable** — Feature: spec-lantern, Property 8
    - **Property 9: Rendering under a fixed clock is deterministic** — Feature: spec-lantern, Property 9
    - **Validates: Requirements 4.1, 4.3, 4.4, 3.6**

  - [ ]* 11.3 Write an integration test for jsdom rendering with injected data
    - Render a representative props-driven component with mocked data via props and assert the render used the injected data; add a negative case asserting an internally-fetching component is recorded unverifiable
    - _Requirements: 4.2, 3.6_

- [ ] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Implement the Comparison Engine
  - [ ] 13.1 Pair predictions with actual results and classify
    - Pair Predicted_Result with Actual_Result when both PASS/FAIL exist and flag inequality as a prediction mismatch
    - Classify FAIL as a Confirmed_Bug and attach its Counterexample; exclude timeouts (mark NOT_COMPARED_TIMEOUT); mark predicted-only properties NOT_EXECUTED
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 13.2 Write property tests for the comparison logic
    - **Property 14: Prediction mismatch is flagged exactly when predicted differs from actual** — Feature: spec-lantern, Property 14
    - **Property 15: FAIL classifies a Confirmed_Bug with its Counterexample; non-FAIL does not** — Feature: spec-lantern, Property 15
    - **Property 16: Timeout outcomes are excluded from comparison** — Feature: spec-lantern, Property 16
    - **Property 17: Predicted-only properties are marked not executed** — Feature: spec-lantern, Property 17
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**

- [ ] 14. Implement the Revive loop (Fix_Tasks, Target_Repo_Copy, Property_Transition)
  - [ ] 14.1 Generate Fix_Tasks for Confirmed_Bugs
    - Generate at least one Fix_Task referencing each Confirmed_Bug property
    - _Requirements: 8.1_

  - [ ] 14.2 Apply fixes to the Target_Repo_Copy only
    - Apply each Fix_Task only to the Target_Repo_Copy, leaving the original Target_Repo byte-for-byte unchanged
    - _Requirements: 8.2_

  - [ ] 14.3 Implement `apply_fixes_and_reexecute` and record Property_Transition
    - Re-execute the same Correctness_Properties against the Target_Repo_Copy in the runner; record Pre_Fix_Result and Post_Fix_Result
    - Build the Property_Transition classification: FIXED (FAIL→PASS), NOT_RESOLVED (FAIL→FAIL), REGRESSION (PASS→FAIL), STILL_PASSING (PASS→PASS)
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7_

  - [ ]* 14.4 Write property tests for the Revive loop
    - **Property 18: Every Confirmed_Bug produces at least one Fix_Task** — Feature: spec-lantern, Property 18
    - **Property 19: Fixes modify only the copy, never the original** — Feature: spec-lantern, Property 19
    - **Property 20: Both pre-fix and post-fix results are recorded on re-execution** — Feature: spec-lantern, Property 20
    - **Property 21: Property_Transition classification matches the pre/post pair** — Feature: spec-lantern, Property 21
    - **Validates: Requirements 8.1, 8.2, 8.4, 8.5, 8.6, 8.7**

  - [ ]* 14.5 Write an integration test for re-execution against the copy
    - After fixes are applied to the Target_Repo_Copy, re-execute the same property set against the copy inside the runner
    - _Requirements: 8.3_

- [ ] 15. Implement Lantern_Report assembly
  - [ ] 15.1 Assemble the Lantern_Report
    - Build a report listing exactly one comparison per evaluated property (with Predicted_Result and Actual_Result), Counterexamples for Confirmed_Bugs, Observed_Deviations with their associated property and predicted-vs-actual difference, and Property_Transitions
    - Set explicit no-Confirmed_Bug and no-Observed_Deviation indications when empty; produce within the configured report-generation limit (default 10s)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [ ]* 15.2 Write property tests for report assembly
    - **Property 22: The report lists every evaluated property with predicted and actual** — Feature: spec-lantern, Property 22
    - **Property 23: The report includes counterexamples, deviations, and transitions it was given** — Feature: spec-lantern, Property 23
    - **Property 24: Empty collections produce explicit indications** — Feature: spec-lantern, Property 24
    - **Validates: Requirements 9.2, 9.3, 9.4, 9.5, 9.6, 9.7**

  - [ ]* 15.3 Write a timed unit test for report generation limit
    - Assert the report is produced within the configured report-generation limit (default 10s) of comparison completion
    - _Requirements: 9.1_

- [ ] 16. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 17. Implement the Lantern_Report_UI
  - [ ] 17.1 Render property rows with predicted vs actual and mismatch indicator
    - Render each Correctness_Property row with Predicted_Result and Actual_Result positioned adjacently in the same row; render all entries within the configured UI render limit (default 3s)
    - Apply a visual mismatch indicator exactly on rows where Predicted differs from Actual, absent where they match
    - _Requirements: 10.1, 10.2, 10.3_

  - [ ] 17.2 Render counterexamples, transitions, and empty/missing states
    - Render the Counterexample on Confirmed_Bug rows, or an "unavailable" indication when missing; render Pre_Fix_Result and Post_Fix_Result on Property_Transition rows
    - Show a "no report exists" message when no Lantern_Report is available
    - _Requirements: 10.4, 10.5, 10.6, 10.7_

  - [ ]* 17.3 Write property tests for UI rendering
    - **Property 25: Each rendered row shows predicted and actual adjacently** — Feature: spec-lantern, Property 25
    - **Property 26: The UI mismatch indicator is present exactly on mismatched rows** — Feature: spec-lantern, Property 26
    - **Property 27: The UI renders counterexamples and transitions it is given** — Feature: spec-lantern, Property 27
    - **Validates: Requirements 10.1, 10.3, 10.4, 10.5**

  - [ ]* 17.4 Write unit tests for UI empty/missing states and render timing
    - Assert the Counterexample-unavailable indication, the no-report message, and that all entries render within the configured UI render limit (default 3s)
    - _Requirements: 10.2, 10.6, 10.7_

- [ ] 18. Implement the static Hosted_Demo (S3 + CloudFront)
  - [ ] 18.1 Export pre-generated sample Lantern_Reports as static assets
    - Add an export step that serializes one or more pre-generated sample Lantern_Reports (produced by the local pipeline) to static JSON/assets the UI loads client-side; the demo contains no runner and executes no Target_Repo code
    - _Requirements: 11.2_

  - [ ] 18.2 Build the static site hosting and infrastructure
    - Configure the S3 + CloudFront static hosting (infrastructure-as-code) so the UI and sample assets are reachable over the public internet with no local install, reusing the same Lantern_Report_UI views
    - _Requirements: 11.1, 11.3_

  - [ ]* 18.3 Write an integration test for the Hosted_Demo
    - Assert the static demo is reachable without local install, serves pre-generated sample reports as static assets (no runner/no execution), and exposes the predicted-vs-actual, Counterexample, and Property_Transition views
    - _Requirements: 11.1, 11.2, 11.3_

- [ ] 19. Author the Kiro_Power artifacts (POWER.md + steering)
  - [ ] 19.1 Write POWER.md and steering guiding the full read-side pipeline
    - Author the steering that drives Reverse_Engineer, Observed_Deviations, 1:1 Claim→Property extraction, immutable Predicted_Result recording, embedded-component handling, and Fix_Task generation, delegating all execution to the MCP_Server tools (`execute_properties`, `apply_fixes_and_reexecute`, `replay_counterexample`)
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 3.1, 3.4, 4.1, 8.1, 8.2_

- [ ] 20. Wire the end-to-end pipeline on the writing-tracker reference Target_Repo
  - [ ] 20.1 Connect all components into the full pipeline
    - Wire Kiro_Power → Safety Gate → runner lifecycle → execution outcomes → Comparison Engine → Revive loop → Lantern_Report → UI, and produce a pre-generated writing-tracker report for the Hosted_Demo
    - Demonstrate at least one Confirmed_Bug with a Counterexample and at least one FIXED (FAIL→PASS) Property_Transition applied to the Target_Repo_Copy and re-executed, with host-safety invariants holding throughout
    - _Requirements: 5.1, 7.1, 8.3, 9.1, 10.1, 11.2, 12.1_

  - [ ]* 20.2 Write an end-to-end integration test for the writing-tracker pipeline
    - Run the full pipeline against writing-tracker and assert a Confirmed_Bug with Counterexample, a FAIL→PASS transition, and that no Target_Repo code ran on the host
    - _Requirements: 5.1, 8.3, 12.1_

- [ ] 21. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (test-related) and can be skipped for a faster MVP, though the property-based tests encode the product's core guarantees (prediction mismatch, replay reproducibility, host safety) and are strongly recommended.
- Each task references the specific requirements and/or Correctness Properties it implements for traceability.
- Property-based tests use fast-check + Vitest, implement exactly one Correctness Property each, run a minimum of 100 iterations, and are tagged `Feature: spec-lantern, Property {n}: {property_text}`.
- Checkpoints provide incremental validation at natural boundaries (pure logic, runner/safety, Revive/report, UI/demo).
- The AWS Fargate execution runner is Future Work and is intentionally NOT included as a task. The static Hosted_Demo (no runner, no execution surface) is in scope and is implemented in task 18.
- The two overriding safety invariants — no host execution and no host fallback — are implemented in tasks 7–8 and verified by dedicated safety property and negative tests (7.3, 7.4, 8.3, 9.5).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1", "2.2"] },
    { "id": 1, "tasks": ["3.1", "4.1", "7.1", "7.2"] },
    { "id": 2, "tasks": ["3.2", "3.3", "4.2", "5.1", "8.1", "8.2", "7.3", "7.4"] },
    { "id": 3, "tasks": ["3.4", "5.2", "5.3", "8.3", "9.1", "11.1"] },
    { "id": 4, "tasks": ["5.4", "5.5", "9.2", "9.3", "11.2", "11.3"] },
    { "id": 5, "tasks": ["9.4", "9.5", "10.1", "13.1"] },
    { "id": 6, "tasks": ["10.2", "13.2", "14.1", "14.2"] },
    { "id": 7, "tasks": ["14.3", "15.1", "19.1"] },
    { "id": 8, "tasks": ["14.4", "14.5", "15.2", "15.3", "17.1", "17.2"] },
    { "id": 9, "tasks": ["17.3", "17.4", "18.1"] },
    { "id": 10, "tasks": ["18.2"] },
    { "id": 11, "tasks": ["18.3", "20.1"] },
    { "id": 12, "tasks": ["20.2"] }
  ]
}
```
