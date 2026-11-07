# Superseded prediction locks (moodplays)

These are the ORIGINAL prediction locks for property-7, property-8, and
property-9, taken during Stage B (2026-11-07). They are retained here, unchanged,
as an audit trail. They are NOT read by the comparison; the active locks in
`../` are authoritative.

## Why they were superseded

reason: **tautological oracle, revised before any execution.**

The first drafts of these three properties checked the code against an oracle
that RESTATED the implementation, so the test would pass even if the code were
wrong — "read and believe" in test form, the exact failure spec-lantern exists
to catch:

- **property-7.claim-format-until-close** — recomputed the same
  `<=0 / <60 / exact-hours / hours+minutes` if-else branches the function uses,
  then compared. Any identical mistake in both would agree.
- **property-8.claim-haversine-distance** — recomputed the Haversine formula
  itself (same `2*asin(sqrt(a))`, same `R = 6371`) and compared to the code,
  mirroring the implementation rather than reality.
- **property-9.claim-format-distance** — recomputed the same
  `km < 1 ? meters : toFixed(1)` conditional as its oracle.

This was caught by REVIEW, before any execution (no Stage C has run). The
predicted verdicts were already locked, so rather than edit a locked prediction
the locks were superseded: the old locks moved here with this note and the
revised property files re-locked in `../`.

## What was revised (and what was NOT)

Revised in the property test files ONLY — each now uses an INDEPENDENT oracle:
- **property-7**: a fixed, hand-written table of `minutes -> expected label`
  authored from the comment's English intent, not from the function's branches.
- **property-8**: known real great-circle distances between real landmark
  coordinate pairs (Tokyo-Osaka, London-Paris, NY-LA, one equatorial degree)
  within stated tolerances, plus formula-independent metric laws (identity,
  non-negativity, symmetry, triangle inequality).
- **property-9**: the two examples the comment itself gives ("500 m", "1.2 km")
  plus hand-computed boundary values around 1 km (0.999 / 1.0 / 1.001) and a few
  more hand-authored anchors.

NOT changed:
- What each property asserts about its claim.
- The PREDICTED verdict for each: still **PASS**, exactly as originally locked
  here (the code does match the claims; the rewrite only makes the oracle
  capable of catching a mismatch if one existed).
- properties 1-6 and 10 and their locks (untouched).

The revised property files were re-locked in `../` (new content hash +
timestamp) because the lock hashes the property source, which legitimately
changed. The predicted verdicts carried over verbatim (PASS).
