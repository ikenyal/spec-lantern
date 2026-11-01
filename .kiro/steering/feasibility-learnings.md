---
inclusion: always
---

# Feasibility learnings (Nov 1, 2026) — read before authoring the Kiro_Power

These learnings come from a hands-on feasibility test on the reference Target_Repo
`writing-tracker` (a Lovable-generated React app). The Kiro_Power steering MUST encode
this proven sequence. Each step below was run as a generic prompt (no bug-specific hints)
and its outcome is recorded.

## Proven pipeline (generic prompts that worked)

1. **Reverse-engineer requirements first (not design).** Starting from requirements
   ("what the feature is SUPPOSED to do") surfaced boundary bugs during requirement
   refinement. Starting from design tends to encode current (buggy) behavior as intent.
2. **Separate intended vs current behavior.** Generic prompt:
   > Some acceptance criteria describe how the current implementation behaves, while
   > others describe what a user would reasonably expect. Wherever these conflict:
   > rewrite the criteria to describe intended behavior from the user's perspective,
   > and move each conflicting current behavior into "Observed Deviations (Suspected Bugs)"
   > with: the requirement it violates, current behavior, expected behavior, source file and line.
   Result: found 3 real bugs (weekly window keeps time-of-day; monthly window ends at
   00:00 of the last day; tasks loaded only from the first 5 stages).
3. **Distrust comments; turn every claim into a property.** Generic prompt:
   > Code comments in AI-generated apps are often wrong. For every code comment and every
   > requirement that makes a claim about ordering, selection, or which item is "first",
   > "latest", or "most active", add a Correctness Property that verifies the claim against
   > the actual runtime behavior, not against the comment. List any claim whose comment
   > and code disagree.
   Result: found 2 more comment/code mismatches.
4. **Execute. Reading is not enough.** Even after step 3, Kiro judged the comment
   "Reverse to have most recent month first" as AGREEING with `periods.reverse()` and
   predicted PASS. Executing a fast-check property ("the first row is the current month")
   FAILED immediately (e.g. in Jan 2020 the first row was Aug 2019).
   This PASS-predicted / FAIL-executed gap is the core of spec-lantern.

## Things that did NOT work

- Kiro's built-in "Analyze Requirements" did not detect logical contradictions between
  criteria (e.g. "windows have no gaps" vs "window start keeps current time-of-day").
  Do not rely on it for bug detection.
- Logic-free targets (landing pages) yield no bugs. Prefer targets with date, ordering,
  aggregation, or filtering logic.

## Development rules for this repository

- `sandbox/` contains local experiments and third-party repos. Never treat it as product code.
- Never run Target_Repo code (install, build, test) on the host. Only inside the Isolated_Runner.
- Time-dependent bugs were reproduced with `TZ=Asia/Tokyo`; always pin TZ, clock, and seed.
