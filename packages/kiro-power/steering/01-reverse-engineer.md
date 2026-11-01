---
inclusion: always
---

# 01 — Reverse-engineer a Kiro spec (R1)

Produce a Kiro spec from the Target_Repo. Follow the proven sequence from the
feasibility test: **requirements first, then design.** Starting from design
tends to encode current (buggy) behavior as intent.

## Preconditions — report failures without a partial spec

Before producing anything, establish the repo is analyzable:

- **R1.4 — unreadable repo.** If the Target_Repo cannot be read (path
  inaccessible, no file can be opened), STOP. Report that reverse-engineering
  cannot proceed, include a human-readable message naming the specific reason,
  and do **not** write any requirements, design, claims, properties, or
  predictions. No partial spec.
- **R1.5 — no analyzable TypeScript source.** If the repo is readable but has
  zero files with a recognized TypeScript extension that parse without fatal
  syntax errors, STOP. Report that reverse-engineering cannot proceed with a
  message indicating "no analyzable TypeScript source was found". No partial
  spec.

Only when at least one analyzable TypeScript source file exists do you proceed.

## R1.1 — Requirements: every behavior → at least one EARS criterion

Generate a requirements document in which **each distinct Target_Repo behavior
you identify is expressed as at least one acceptance criterion conforming to one
of the six EARS patterns** (Ubiquitous, Event-driven WHEN, State-driven WHILE,
Optional-feature WHERE, Unwanted-behavior IF/THEN, and Complex combinations).

Write criteria as **intended behavior from the user's perspective**, not as a
transcription of current code. Where a comment or current behavior conflicts
with what a user would reasonably expect, write the criterion for the intended
behavior and carry the conflict into Observed_Deviations (see
`02-observed-deviations.md`). Do not let a misleading comment define intent.

## R1.2 — Design: at least one Correctness_Property per requirement

Generate a design document with a non-empty **Correctness_Properties** section
containing **at least one correctness property for each generated requirement**.
Every requirement must map to one or more properties; no requirement is left
without a property. State each property as a universal ("for all …") claim about
behavior, and record which requirement(s) it validates.

## R1.3 — Record each comment-described behavior as a referenced Claim

Distrust comments. **For every code comment (and every requirement/doc) that
makes a claim about behavior** — especially ordering, selection, or which item
is "first", "latest", "most recent", or "most active" — record a **distinct
Claim**. Each Claim MUST carry:

- a non-empty `sourceFile` (the file it was derived from), and
- a non-empty `commentRef` (the comment text or line it came from).

One described behavior → one Claim. Do not merge two described behaviors into a
single Claim, and do not emit a Claim with empty origin references. Write Claims
in the `claims.json` format from `05-artifact-formats.md`.

The canonical example from `writing-tracker`: the comment "Reverse to have most
recent month first" is recorded as a Claim referencing its source file and that
comment. Its property (authored in `03-claims-to-properties.md`) asserts the
first row is the current month — which execution later disproves.

## Output of this step

- A requirements document (EARS criteria, intended behavior).
- A design document with a non-empty Correctness_Properties section, ≥1 property
  per requirement.
- `claims.json` — every comment-described behavior as a distinct, referenced
  Claim.

Carry the Claims forward into deviation analysis and property extraction.
