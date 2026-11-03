# Superseded prediction locks (writing-tracker-full)

These are the ORIGINAL prediction locks for property-2 and property-3, taken
together with property-1 at **2026-11-03T05:21:22Z** (Stage B). They are retained
here, unchanged, as an audit trail. They are NOT read by the comparison; the
active locks in `../` are authoritative.

## Why they were superseded

The FIRST Stage-C execution (two-phase Podman runner) revealed that property-2
and property-3 contained **test-harness defects** — bugs in how the property
test located/compared the rendered DOM, NOT in what they assert about the claim
and NOT in the Target_Repo:

- **property-2.claim-active-tasks-recent** — produced `EXECUTION_ERROR`
  ("last-updated cell not rendered"). Cause: the test located the "Recently
  Active Tasks" table by walking an assumed card DOM shape
  (`heading.closest("div").parentElement.parentElement`), which did not reliably
  resolve to that table, so the first data row's Last-Updated cell read empty and
  the test threw its own guard. No genuine PASS/FAIL verdict was produced.

- **property-3.claim-active-stages-top5** — produced a FAIL that did NOT reflect
  a real ordering violation. Counterexample: `titles:[" "," "," "," "]`,
  `progresses:[0,3,1,2]`. The highest-score stage (index 1) WAS rendered first
  (ordering correct), but the generated title was whitespace (`" #1"`), the
  rendered cell was read with `.trim()` (`"#1"`), and the expected title was
  compared UN-trimmed (`" #1"`) — a whitespace/trim mismatch in the assertion,
  not a target bug.

## What was revised (and what was NOT)

Revised in the property test files ONLY:
- Robust table lookup: locate each table by its unique column header
  ("Last Updated" / "Stage") and read the first `<tbody>` data row.
- Consistent trimming on both the expected and the rendered side.
- property-3's generated title made whitespace-free so the identity cannot trim
  away.

NOT changed:
- What each property asserts about its claim (property-2 still asserts the first
  Recently-Active-Tasks row is the most recently updated task; property-3 still
  asserts the first Most-Active-Stages row is the highest-scoring stage and the
  table shows at most five rows).
- The PREDICTED verdict for each: still **PASS** for both, exactly as originally
  locked here.
- property-1 and its lock (untouched).

The revised property files were re-locked in `../` (new content hash + timestamp)
because the lock hashes the property source, and the source legitimately changed
to fix the harness. The predicted verdicts carried over verbatim (PASS/PASS).
