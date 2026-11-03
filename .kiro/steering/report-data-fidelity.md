---
inclusion: always
---

# Report data fidelity — never fabricate claims, lines, or results

A Lantern_Report exists to expose where an app's own claims are lies. If the
report itself contains invented data, the tool is doing the exact thing it was
built to catch. Every value that reaches the Lantern_Report_UI — whether real
pipeline output or temporary sample data — MUST be traceable to something that
was actually read from the source or actually observed by execution.

## Rules

1. **Claims are quoted verbatim.** Every `claimText` must be an exact,
   character-for-character quote of a real comment (or other claim) in the
   Target_Repo source. Do not paraphrase, "clean up", complete, or infer it.
2. **Source locations are exact.** Every `sourceLocation` (file + line) must
   point at the line the quoted claim actually lives on. Verify the line number
   against the real file; do not guess. If a line is not a claim (e.g. it is
   just `}`), it is not a source for a claim.
3. **Verdicts and counterexamples are observed, never invented.** A row's
   `predicted`, `actual`, `counterexample`, and `transition` must reflect what
   a real execution produced (predicted recorded before the run; actual and any
   counterexample recorded from the run). Never author a PASS/FAIL, an
   Expected-vs-Actual, or a pre/post-fix transition that was not executed.
4. **If it cannot be verified, omit it.** A property whose claim or result has
   not been verified does not belong in the report. Prefer a smaller, fully
   verified report over a larger one padded with plausible-looking rows.
5. **Sample data is clearly labeled.** Any hand-authored stand-in report
   (currently `packages/ui/src/sample-report.ts`) must still satisfy rules 1–4
   AND be surfaced to the user as sample data (the `sampleData` prop drives the
   "Sample data" badge in `LanternReportView`). Remove the sample file and the
   flag once the real pipeline output (task 20) feeds the UI.

## Why (concrete miss this rule prevents)

An early demo sample invented a second row — comment
`"Window covers the last 7 days including today"` at
`PeriodProgressSummary.tsx:38` — that does not exist in the source (line 38 is
just `}`), and asserted a weekly-window verdict that was never executed. Only
the monthly-ordering row (`"Reverse to have most recent month first"`,
`PeriodProgressSummary.tsx:54`) was real. Fabricated rows like this must never
ship, even as a placeholder.
