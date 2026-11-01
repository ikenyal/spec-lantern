---
inclusion: always
---

# 02 — Observed_Deviations: intended vs current behavior (R2)

After reverse-engineering, build the **Observed_Deviations** list: the
documented differences between what each Claim says the app should do (intended)
and what it actually does (current). Write it in the `observed-deviations.json`
format from `05-artifact-formats.md`.

This analysis is still read-side: you describe the *claimed* behavior from the
Claim and your read of *current* behavior from the code. Executed confirmation
comes later from `execute_properties`; this list captures the suspected
divergences a reader can see, each tied to its Claim.

## R2.1 / R2.2 — one entry per differing Claim, referencing its Claim

For each evaluated Claim whose claimed behavior differs from current behavior,
emit exactly one Observed_Deviation entry containing:

- `claimId` — a valid reference to the originating Claim (R2.2),
- `claimedBehavior` — a non-empty description of the claimed behavior,
- `currentBehavior` — a non-empty description of the current behavior.

One difference → one entry. Every entry must reference an existing Claim id; a
dangling reference is invalid.

## R2.3 — no difference → empty list

If, across all evaluated Claims, no claimed behavior differs from current
behavior, produce an Observed_Deviations list with **zero entries**. An empty
list is a valid, meaningful result — do not fabricate entries and do not omit
the file. Write `{ "deviations": [] }`.

## R2.4 — undeterminable Claim

If a Claim cannot be evaluated against current behavior because the relevant
behavior is absent or inaccessible, record an Observed_Deviation that:

- references the originating Claim (`claimId`),
- sets `undeterminable: true`,
- sets `currentBehavior: null` (the `null` and the `undeterminable: true` marker
  always travel together),
- keeps a non-empty `claimedBehavior`.

Recording an undeterminable entry MUST NOT drop any other evaluated Claim —
**retain all other evaluated Claims** in the list alongside the undeterminable
one.

## Relationship to properties and the report

- Deviation analysis does not replace property execution. A suspected deviation
  becomes a *confirmed* finding only when the property executes to FAIL.
- Every deviation references a Claim, and that Claim maps 1:1 to a
  Correctness_Property (see `03-claims-to-properties.md`), so the later
  Lantern_Report can list each Observed_Deviation with its associated property
  and the predicted-vs-actual difference (R9.4).
