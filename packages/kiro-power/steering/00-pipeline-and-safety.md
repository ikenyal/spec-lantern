---
inclusion: always
---

# 00 — Pipeline and safety (read first)

This file governs every other steering file in this Power. It defines the
end-to-end pipeline, the execute-don't-trust contract, the MCP tool delegation
surface, and the non-negotiable host-safety invariants.

## The end-to-end pipeline

```
Target_Repo
  → Reverse_Engineer spec            (01-reverse-engineer.md)      R1
  → Observed_Deviations              (02-observed-deviations.md)   R2
  → Claim → Correctness_Property 1:1 (03-claims-to-properties.md)  R3, R4
  → Record immutable Predicted_Result + LOCK                       R3.4, R3.5
  → execute_properties  (MCP)                                      R5, R6
  → Comparison: predicted vs actual (read the result)              R7
  → Fix_Tasks per Confirmed_Bug → apply to Target_Repo_Copy        R8.1, R8.2
  → apply_fixes_and_reexecute (MCP) → Property_Transition          R8.3–R8.7
  → Lantern_Report                                                 R9
```

Kiro, driven by this Power, owns the read-side (reverse-engineer, deviation
analysis, Claim→Property extraction, property-test authoring, prediction, fix
authoring). The MCP_Server owns all execution.

## Execute, don't trust

- A Predicted_Result is Kiro's **read-only** guess, recorded by *reading* code.
  It is NEVER the verdict in a report.
- The Actual_Result comes ONLY from executing the property in the runner.
- The product's whole point is surfacing where predicted ≠ actual. Record an
  honest prediction from reading — including trusting a comment if that is what
  the code appears to do — so the mismatch is meaningful. Do not "fix" a
  prediction to match what you suspect execution will show.

### The prediction lock (critical ordering)

The Predicted_Result MUST be recorded and **locked before execution begins**,
and is immutable thereafter (R3.4, R3.5).

1. Write each Predicted_Result file (see `05-artifact-formats.md`).
2. Call the MCP prediction-**lock** tool to lock every Predicted_Result together
   with the Correctness_Property artifact it refers to. The lock computes a
   content hash + timestamp and persists it so the prediction cannot change once
   execution starts.
3. ONLY AFTER locking, call `execute_properties`.

Never reorder these. If you discover a prediction was wrong *after* locking, do
NOT rewrite it — the mismatch is the finding. Later comparison always reads the
locked value.

## MCP tool delegation surface (the ONLY way to execute)

This Power never runs Target_Repo code. It calls these MCP_Server tools:

| Tool | Input | Output | Use for |
| --- | --- | --- | --- |
| prediction-lock tool | the Predicted_Result files + the properties they refer to | a persisted lock (hash + timestamp) | locking predictions before execution (R3.4, R3.5) |
| `execute_properties` | `PropertyExecutionRequest` (`{ targetRepoRef, properties[], phase: "initial" }`) | `PropertyExecutionResult` (`ActualResult[]` + per-property `ExecutionContext`) | running every property against the Target_Repo in the runner (R5, R6) |
| `apply_fixes_and_reexecute` | `{ targetRepoCopyRef, fixTasks[], properties[] }` | `PropertyExecutionResult` with Pre/Post results | applying Fix_Tasks to the Target_Repo_Copy and re-running (R8.3) |
| `replay_counterexample` | `{ property, executionContext }` | `Actual_Result` (equals the original) | reproducing a counterexample exactly (R6.3) |

The `ActualResult` union is closed and comes from `@spec-lantern/types`:
`VERDICT` (carries `verdict: "PASS" | "FAIL"` and, on FAIL, a `Counterexample`),
`TIMEOUT` (carries `limitSeconds`), `EXECUTION_ERROR` (carries `reason`),
`RUNNER_UNAVAILABLE` (carries `reason`), `SAFETY_VIOLATION` (carries `reason`).
Timeouts and errors are NEVER PASS or FAIL — read them as their own outcomes.

## Host-safety invariants (never violate)

1. **No host execution.** Never run any Target_Repo install, build, script, or
   test on the host or in a tool shell. If you are tempted to run `npm install`,
   `vitest`, `tsc`, or the target's own scripts to "check" something — stop.
   Delegate to `execute_properties`. The MCP_Server's Safety Gate will reject a
   host-bound request with a `SAFETY_VIOLATION` before anything runs; do not
   construct such requests in the first place.
2. **No host fallback.** If the runner is unavailable the tool returns
   `RUNNER_UNAVAILABLE`. Never respond by running the target on the host. Report
   the runner-unavailable reason to the user and stop.
3. **Pin determinism.** Time-dependent bugs reproduce only under a fixed clock,
   timezone, and seed. The runner records an `ExecutionContext` (Random_Seed,
   timezone, Fixed_Current_Time) per execution; author properties that assume a
   pinned `TZ` and fixed current time (the `writing-tracker` monthly bug
   reproduced under `TZ=Asia/Tokyo`). Never rely on the host's wall clock.

## Scope note

`sandbox/` holds local experiments and third-party repos (including the
`writing-tracker` reference Target_Repo). It is never product code. Target
repos are analyzed; they are not part of this Power.
