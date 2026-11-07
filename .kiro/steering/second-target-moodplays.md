---
inclusion: always
---

# Second Target_Repo: MoodPlays (staged, with stop points)

Target: sandbox/moodplays = gargi04sahu/MoodPlays @ 4b4152f (MIT, © 2026 Gargi Sahu).
Selection was pre-registered in docs/target-selection.md. Work in a new spec root
packages/mcp-server/skeleton/moodplays/ with the same layout as writing-tracker-full.

Run the same stages as writing-tracker (see task20-e2e-stages.md for details).
At the end of EACH stage, STOP, report, and wait for "continue".

## Global rules
- Same as writing-tracker: target code runs ONLY in the two-phase Podman runner;
  sandbox/ is read-only; report-data-fidelity applies; predictions are written and
  LOCKED before any execution and never edited (a harness fix keeps the predicted
  verdict, moves the old lock to locks/superseded/ with a note).
- Do not look for bugs before locking. Extract EVERY claim-like comment in the
  executable logic (start with src/utils/openingHoursParser.ts and the PlaceCard
  component that uses it), not only suspicious ones. Mark claims unverifiable if
  they depend on Supabase or network.
- Persist every tool output verbatim under results/ (stage-c, stage-d). Reports
  read only from files.
- An honest "0 lies found" is an acceptable outcome. Never stretch a claim to
  manufacture a FAIL.

## Stages
- B: claims (verbatim, file:line), deviations, properties, predictions; lock; validate.
  Report the claim table with predictions and lock time.
- C: execute via MCP execute_properties; persist; replay any FAIL via
  replay_counterexample. Report outcomes, mismatches, counterexamples.
- D: for each Confirmed_Bug, minimal Fix_Task via apply_fixes_and_reexecute on the
  copy; re-run ALL properties for regression. Report diffs and transitions.
- E: add MoodPlays as a second report in the UI (report index lists both targets);
  keep writing-tracker unchanged. Do NOT deploy.
