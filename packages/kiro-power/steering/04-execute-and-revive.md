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

Call `execute_properties` with `{ targetRepoRef, phase: "initial", specRoot }`
and OMIT `properties` — the server derives the Correctness_Property objects from
your spec (`claims.json` + `properties/`). It copies the target to a throwaway
working copy and places each property file at the SAME location (relative to the
target) it has in your spec — in place when `specRoot` is inside the target, or
copied to a fixed path when it is outside — so the relative/alias imports you
wrote (see `03-claims-to-properties.md`) resolve. You do not place files inside
the copy by hand, and you do not hand-write the property objects. The tool
persists its result verbatim and returns a `resultsPath`; keep that path for
`compare_predictions`. Read the `PropertyExecutionResult`: an `ActualResult[]`
plus a per-property `ExecutionContext`. Interpret each outcome by its tag, never
guessing:

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

## Compare predicted vs actual (delegate to `compare_predictions`)

Do NOT hand-write the comparison. `execute_properties` persisted its result and
returned a `resultsPath`; call `compare_predictions` with
`{ specRoot, resultsPath }`. It reads each predicted verdict ONLY from the
on-disk Prediction_Locks (never from you), runs the Comparison Engine against
the persisted Actual_Results, and writes `<specRoot>/comparison.json`.

Read its summary: each property's `status` (`MATCH` / `PREDICTION_MISMATCH` /
`NOT_COMPARED_TIMEOUT` / `NOT_EXECUTED`), `confirmedBug`, and two distinct
counts. `lieCount` is the number of **lies** — Confirmed_Bugs (actual FAIL)
grouped by root cause; a confirmed bug is a lie even when its prediction
matched (a predicted-FAIL / actual-FAIL row is still a lie). `predictionMismatchCount`
is the number of rows whose predicted verdict differs from the actual one
(`PREDICTION_MISMATCH`); `confirmedBugCount` is the ungrouped number of confirmed
bugs. A lie is NOT the same as a prediction mismatch.
A `PREDICTION_MISMATCH` (predicted ≠ actual, both PASS/FAIL) is the core finding;
a property whose Actual_Result is FAIL is a **Confirmed_Bug** carrying its
Counterexample. Your job here is to drive the fix loop for each Confirmed_Bug.

When one defect makes several properties fail, pass `rootCauses`
(`{ "<rootCause propertyId>": ["<symptom propertyId>", ...] }`); the tool groups
the symptoms under the root cause and counts the lie ONCE per root cause rather
than once per symptom. Do not count lies by hand.

If you need to reproduce a specific failure exactly, call `replay_counterexample`
with `{ specRoot, targetRepoRef, propertyId, executionContext }` (the recorded
`ExecutionContext` from the failing result); it reproduces the original
Actual_Result and persists its own result too.

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

Call `apply_fixes_and_reexecute` with `{ targetRepoRef, specRoot, applications[],
preFixResults }` (omit `properties` — the server derives them from the spec; pass
`preFixResults` as the persisted `results` array or a record). It applies the
fixes to a throwaway copy and re-runs the same properties inside the runner,
returning Pre_Fix_Result and Post_Fix_Result per property. Read the resulting
Property_Transition classification:

- `FIXED` — FAIL → PASS,
- `NOT_RESOLVED` — FAIL → FAIL,
- `REGRESSION` — PASS → FAIL,
- `STILL_PASSING` — PASS → PASS.

The result also carries `unifiedDiff` — the ACTUAL unified diff of the edits
applied to the copy, computed by the tool with line endings preserved. That diff
is authoritative; do NOT hand-write or transcribe a diff. The tool also persisted
its full result and returned a `resultsPath`.

Report these transitions as the Revive outcome. The demo target
(`writing-tracker`) must show at least one Confirmed_Bug with a Counterexample
and at least one `FIXED` (FAIL → PASS) transition applied to the copy.

## What this step never does

- It never runs the target on the host.
- It never falls back to the host when the runner is unavailable.
- It never modifies the original Target_Repo.
- It never rewrites a locked Predicted_Result to match the Actual_Result.

## Evidence discipline (learned from real runs)

- **The tools persist their own output — read it back, never transcribe it.**
  Every tool call with a `specRoot` writes its EXACT result to
  `<specRoot>/results/<UTC-timestamp>-<tool>.json` and returns that `resultsPath`;
  `compare_predictions` additionally writes `<specRoot>/comparison.json`. Reports
  and summaries read only from these files, never from chat text. Do not hand-copy
  a result, comparison, or diff into a file — that hand-work caused a real
  transcription error and is exactly what these tools remove.
- **Replay every FAIL** with `replay_counterexample`; it persists the replay and
  returns its path.
- **Harness defects are not bugs.** If a FAIL is caused by the test itself
  (brittle lookup, untrimmed comparison), do not report it as a Confirmed_Bug.
  Fix only the test, keep the predicted verdict unchanged, move the old lock to
  `locks/superseded/` with a README (what was wrong, when relative to
  execution, original lock time), and re-lock.
- **Count lies by root cause via `compare_predictions`.** A lie is a
  Confirmed_Bug (actual FAIL), independent of whether its prediction matched —
  not a prediction mismatch. If one defect makes several properties fail, pass
  `rootCauses` so the tool's `lieCount` counts one lie per root cause and groups
  the symptoms — do not tally lies by hand. The separate `predictionMismatchCount`
  tells you where your read-only prediction disagreed with execution. State
  honestly whether each symptom's own comment is wrong or only failed because of
  the root cause.
- **Re-run all properties after a fix** (not only the failing ones) so the
  report can show STILL_PASSING vs REGRESSION. `apply_fixes_and_reexecute`
  re-runs the full derived property set for you.
