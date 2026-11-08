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
  → execute_properties  (MCP) → persists its result, returns path  R5, R6
  → compare_predictions (MCP): locks vs persisted result           R7
  → Fix_Tasks per Confirmed_Bug → apply to Target_Repo_Copy        R8.1, R8.2
  → apply_fixes_and_reexecute (MCP) → Property_Transition + diff    R8.3–R8.7
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
| `execute_properties` | `{ targetRepoRef, phase: "initial", specRoot, properties?[] }` | `PropertyExecutionResult` + `resultsPath` | running every property against the Target_Repo in the runner (R5, R6) |
| `compare_predictions` | `{ specRoot, resultsPath, rootCauses? }` | comparison summary (`lieCount`, per-property status) + `comparison.json` path | comparing the locked predictions against a persisted execution result (R7) |
| `apply_fixes_and_reexecute` | `{ targetRepoRef, applications[], preFixResults, specRoot, properties?[] }` | Pre/Post results + `unifiedDiff` + `resultsPath` | applying Fix_Tasks to a throwaway copy and re-running (R8.3) |
| `replay_counterexample` | `{ targetRepoRef, executionContext, specRoot, propertyId or property }` | `Actual_Result` + `resultsPath` | reproducing a counterexample exactly (R6.3) |

`targetRepoRef` is always the path to the user's ORIGINAL Target_Repo. Every one
of these tools COPIES that repo into a fresh throwaway working copy and runs
against the COPY — it never mounts or writes to the original (the install phase
would otherwise write `node_modules` and rewrite `package.json`/`package-lock.json`
into the user's repo). Pass the original path directly; do NOT make a copy
yourself. The optional `specRoot` lets the server stage each property's
`properties/property-{n}.{claimId}.test.ts` from your spec root INTO the copy, so
you never have to place test files inside the target by hand.

**Let the server do the mechanical work — do not hand-write it.**

- **Derive properties from the spec.** When you pass `specRoot`, you may OMIT
  the `properties` array (and, for `replay_counterexample`, the `property`
  object — pass `propertyId` instead). The server reconstructs the
  Correctness_Property objects from `claims.json` + your `properties/` test
  files. Only pass an explicit `properties[]` when you have a reason to override
  the spec. If an input cannot be derived or is malformed, the tool returns an
  error that includes a minimal valid example of the expected input — follow it.
- **The tools persist their own results.** Every tool call with a `specRoot`
  writes its EXACT result verbatim to `<specRoot>/results/<UTC-timestamp>-<tool>.json`
  and returns that path as `resultsPath`. Never transcribe a tool's result into
  a file yourself — read it back from the returned path.
- **`preFixResults` takes the shape `execute_properties` returned.** Pass either
  the `results` array verbatim, or a record keyed by `propertyId`. Both are
  accepted; do not reshape by hand.

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
4. **The target is read-only.** `execute_properties`, `replay_counterexample`,
   and `apply_fixes_and_reexecute` each copy `targetRepoRef` into a fresh
   throwaway working copy and run against the COPY; the original repo is never
   mounted or written. Always pass the user's original Target_Repo path — never
   pre-install, pre-build, or pre-copy it yourself, and never pass a path you
   want preserved as a copy destination.

## Scope note

`sandbox/` holds local experiments and third-party repos (including the
`writing-tracker` reference Target_Repo). It is never product code. Target
repos are analyzed; they are not part of this Power.

## Tool call shapes (copy these; do not read the server source)

With a `specRoot` the server derives the Correctness_Property objects from the
spec and stages each test file from `properties/property-{n}.{claimId}.test.ts`
into the throwaway working copy for you. `targetRepoRef` is the ORIGINAL target
path — the server copies it and mounts the copy, so the original stays
read-only. Prefer OMITTING `properties`; the derived objects are authoritative.

```json
// execute_properties — properties DERIVED from the spec (preferred)
{
  "targetRepoRef": "/absolute/path/to/target-repo",
  "specRoot": "/absolute/path/to/spec-root",
  "phase": "initial"
}
```

```json
// compare_predictions — predictions come from the LOCKS, actuals from the persisted result
{
  "specRoot": "/absolute/path/to/spec-root",
  "resultsPath": "/absolute/path/to/spec-root/results/<timestamp>-execute_properties.json",
  "rootCauses": {
    "property-4.claim-open-24-hours": ["property-5.claim-symptom"]
  }
}
```

```json
// apply_fixes_and_reexecute (properties DERIVED; edits + re-run hit the copy only)
{
  "targetRepoRef": "/absolute/path/to/target-repo",
  "specRoot": "/absolute/path/to/spec-root",
  "preFixResults": { "property-4.claim-open-24-hours": { /* its persisted ActualResult */ } },
  "applications": [
    {
      "fixTask": {
        "id": "fix-1.claim-open-24-hours",
        "confirmedBugPropertyId": "property-4.claim-open-24-hours",
        "description": "Detect real 24-hour phrasing instead of any '24' substring",
        "appliesTo": "Target_Repo_Copy"
      },
      "edits": [
        { "kind": "write", "path": "src/utils/openingHoursParser.ts", "contents": "<full new file>" }
      ]
    }
  ]
}
```

`preFixResults` also accepts the `results` array from a persisted
`execute_properties` result verbatim (an array instead of a record).
`lock_prediction` takes `{ specRoot, claimId, propertyNumber }`.
`replay_counterexample` takes `{ targetRepoRef, specRoot, executionContext }`
plus `propertyId` (the property is derived from the spec) or an explicit
`property` object. Preserve the file's original line endings (CRLF vs LF) when
writing `contents` — `apply_fixes_and_reexecute` returns the real `unifiedDiff`
of what it applied, which also preserves line endings.
