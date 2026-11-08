---
inclusion: always
---

# 04 — Execute, compare, and revive (R8)

Everything before this step was read-side authoring. Now the artifacts run —
**but never on the host.** All execution is delegated to the MCP_Server tools.

## Precondition

Predictions must already be written AND locked (see `03-claims-to-properties.md`).
Never call `execute_properties` before the prediction lock tool has locked every
Predicted_Result. The lock is what makes the later comparison trustworthy.

## Execute (delegate to `execute_properties`)

Call `execute_properties` with a `PropertyExecutionRequest`:
`{ targetRepoRef, properties[], phase: "initial" }`. Read the
`PropertyExecutionResult`: an `ActualResult[]` plus a per-property
`ExecutionContext`. Interpret each outcome by its tag, never guessing:

- `VERDICT` → `verdict` is PASS or FAIL; on FAIL a `Counterexample` is attached
  (triggering input + observed output + its `ExecutionContext`).
- `TIMEOUT` → excluded from PASS/FAIL; carries `limitSeconds`.
- `EXECUTION_ERROR` → target raised/failed to load; carries `reason`; no verdict.
- `RUNNER_UNAVAILABLE` → runner could not be created; carries `reason`. **Do not
  fall back to the host.** Report it and stop.
- `SAFETY_VIOLATION` → the request would have run target code on the host and was
  rejected before anything ran. Never construct such a request.

Never execute the target yourself to "double-check" a result. The tool's output
is the source of truth for Actual_Results.

## Compare predicted vs actual (read-side)

For each property, pair the **locked** Predicted_Result with the Actual_Result.
Where predicted ≠ actual (both PASS/FAIL), it is a prediction mismatch — the
core finding of spec-lantern. A property whose Actual_Result is FAIL is a
**Confirmed_Bug**, carrying its Counterexample. (The Comparison Engine formalizes
this in code; your job here is to drive the fix loop for each Confirmed_Bug.)

If you need to reproduce a specific failure exactly, call `replay_counterexample`
with the property and its recorded `ExecutionContext`; it reproduces the original
Actual_Result.

## R8.1 — one or more Fix_Tasks per Confirmed_Bug

For **every** Correctness_Property classified as a Confirmed_Bug, generate **at
least one Fix_Task**. Each Fix_Task MUST set:

- `confirmedBugPropertyId` — the Confirmed_Bug property it resolves,
- a non-empty `description` of the code change,
- `appliesTo: "Target_Repo_Copy"`.

No Confirmed_Bug may be left without a Fix_Task.

## R8.2 — fixes touch only the Target_Repo_Copy

Fix_Tasks apply **only to the Target_Repo_Copy**. The original Target_Repo is
left byte-for-byte unchanged. Never edit the original — not to "try" a fix, not
to verify. The `appliesTo` field is pinned to `"Target_Repo_Copy"`; honor it.

## Re-execute and read the transition (delegate to `apply_fixes_and_reexecute`)

Call `apply_fixes_and_reexecute` with `{ targetRepoCopyRef, fixTasks[],
properties[] }`. It applies the fixes to the copy and re-runs the same
properties inside the runner, returning Pre_Fix_Result and Post_Fix_Result per
property. Read the resulting Property_Transition classification:

- `FIXED` — FAIL → PASS,
- `NOT_RESOLVED` — FAIL → FAIL,
- `REGRESSION` — PASS → FAIL,
- `STILL_PASSING` — PASS → PASS.

Report these transitions as the Revive outcome. The demo target
(`writing-tracker`) must show at least one Confirmed_Bug with a Counterexample
and at least one `FIXED` (FAIL → PASS) transition applied to the copy.

## What this step never does

- It never runs the target on the host.
- It never falls back to the host when the runner is unavailable.
- It never modifies the original Target_Repo.
- It never rewrites a locked Predicted_Result to match the Actual_Result.

## Evidence discipline (learned from real runs)

- **Persist every tool output verbatim** under `results/` (for example
  `results/stage-c/<propertyId>.json`, `results/stage-d/...`). Reports and
  summaries read only from these files, never from chat text.
- **Replay every FAIL** with `replay_counterexample` and persist the replay.
- **Harness defects are not bugs.** If a FAIL is caused by the test itself
  (brittle lookup, untrimmed comparison), do not report it as a Confirmed_Bug.
  Fix only the test, keep the predicted verdict unchanged, move the old lock to
  `locks/superseded/` with a README (what was wrong, when relative to
  execution, original lock time), and re-lock.
- **Count lies by root cause.** If one defect makes several properties fail,
  report one lie and mark the other rows as symptoms of it. State honestly
  whether each symptom's own comment is wrong or only failed because of the
  root cause.
- **Re-run all properties after a fix** (not only the failing ones) so the
  report can show STILL_PASSING vs REGRESSION.
