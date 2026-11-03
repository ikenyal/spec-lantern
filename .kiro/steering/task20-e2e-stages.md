---
inclusion: always
---

# Task 20 (end-to-end on writing-tracker): staged execution with stop points

Task 20 is the MVP completion and the source of the real demo report. Do it in
the stages below. At the end of EACH stage, STOP, report the results listed for
that stage, and wait for the user to say "continue". Do not run stages ahead.

## Global rules (all stages)
- Target code (sandbox/writing-tracker) runs ONLY inside the two-phase Podman
  runner. Never install or run it on the host. sandbox/ stays read-only
  (work on a Target_Repo_Copy).
- Follow report-data-fidelity: claims quoted verbatim with exact file:line,
  verdicts and counterexamples only from real execution, nothing invented.
- Predictions are written and LOCKED (prediction-lock) BEFORE any execution;
  never edit a locked prediction.

## Stage A — make the MCP server usable from Kiro
- Give packages/mcp-server a runnable stdio entry (bin / start script).
- Register it for this workspace (.kiro/settings/mcp.json) and add the same
  config to the Kiro Power (packages/kiro-power, mcp.json) so installing the
  Power brings the tools.
- Report: the config, and proof that Kiro lists the tools
  (execute_properties, replay_counterexample, apply_fixes_and_reexecute,
  prediction lock).

## Stage B — Kiro follows the Power on writing-tracker (no execution yet)
- Produce the Power artifacts for writing-tracker: requirements (reverse
  engineered), observed-deviations.json, claims.json, property test files,
  and predictions. Lock the predictions.
- Must include the monthly-ordering claim
  "Reverse to have most recent month first" (PeriodProgressSummary.tsx:54).
- Report: a table of every claim (verbatim text, file:line, property id,
  Kiro's predicted PASS/FAIL) and the lock hash/timestamp. Run the Validator.

## Stage C — execute in the runner and compare
- Run all properties via the MCP execute_properties tool (two-phase runner).
- Report: per property the actual outcome; every PREDICTION_MISMATCH and
  Confirmed_Bug with its Counterexample and Execution_Context; any
  TIMEOUT / EXECUTION_ERROR with the reason. No spec-lantern containers or
  networks left behind.

## Stage D — revive
- For each Confirmed_Bug, write a minimal Fix_Task and apply it via
  apply_fixes_and_reexecute to the Target_Repo_Copy only.
- Report: the diff of each fix, each Property_Transition
  (FIXED / NOT_RESOLVED / REGRESSION / STILL_PASSING), and proof that
  sandbox/writing-tracker is unchanged.

## Stage E — real report
- Assemble the Lantern_Report from stages B–D, export it for the UI, and
  replace the sample report (sampleData false, badge disappears).
- Report: how to view it locally (npm run dev -w @spec-lantern/ui).
  Do NOT deploy; the user deploys after reviewing the page.
