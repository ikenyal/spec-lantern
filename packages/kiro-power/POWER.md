---
name: spec-lantern
description: >-
  Resurrect abandoned "vibe-coded" TypeScript/React apps by reverse-engineering
  a Kiro spec, extracting every claim into an executable Correctness_Property,
  recording an immutable read-only prediction, then EXECUTING the properties in
  an isolated runner and comparing predicted vs actual. Use when reviving a
  Target_Repo, auditing AI-generated code whose comments may lie, or producing a
  Lantern_Report of confirmed bugs with counterexamples.
keywords:
  - spec-lantern
  - reverse-engineer
  - property-based-testing
  - vibe-coded
  - execute-dont-trust
  - revive
author:
  name: spec-lantern
license: MIT
---

# spec-lantern Kiro Power

The guiding insight: **an agent that only READS code trusts misleading
comments and draws wrong conclusions.** In the feasibility test, a comment said
"Reverse to have most recent month first", Kiro read `periods.reverse()`,
judged the two in agreement, and predicted PASS — but an executed property-based
test proved the oldest month was shown first (FAIL).

This Power therefore never stops at reading. It extracts every claim into an
**executable Correctness_Property**, records Kiro's read-only **Predicted_Result
before execution**, then delegates execution to the MCP_Server and compares the
prediction against reality. Every PASS/FAIL verdict in a Lantern_Report comes
from execution, never from reading.

## Two overriding rules

1. **Execute, don't trust.** This Power NEVER runs Target_Repo code itself — not
   on the host, not in a tool shell, never. All execution is delegated to the
   MCP_Server tools (`execute_properties`, `apply_fixes_and_reexecute`,
   `replay_counterexample`). Predictions exist only to be *compared against*
   executed results.
2. **The original is sacred.** Fixes are applied only to the Target_Repo_Copy.
   The user's Target_Repo is never modified.

## When to use this Power

Use it when a user hands you a TypeScript/React Target_Repo (typically generated
by Lovable, Bolt, v0, or similar) and wants it reverse-engineered into a spec,
audited for bugs, or revived. The reference Target_Repo for the MVP demo is
`writing-tracker`.

## The pipeline (follow in order)

The full procedure is split across focused steering files under `steering/`.
Read them in this order and follow each exactly:

1. **`steering/00-pipeline-and-safety.md`** — the end-to-end pipeline, the
   execute-don't-trust contract, the MCP tool delegation surface, and the
   host-safety invariants. Read this first; it governs everything else.
2. **`steering/01-reverse-engineer.md`** — produce EARS requirements and a
   design whose Correctness_Properties section has at least one property per
   requirement; record each comment-described behavior as a referenced Claim;
   handle unreadable / no-analyzable-source repos without a partial spec
   (R1.1–R1.5).
3. **`steering/02-observed-deviations.md`** — build the Observed_Deviations list:
   one entry per claimed-vs-current difference referencing its Claim, the
   empty-list case, and the undeterminable entry (R2.1–R2.4).
4. **`steering/03-claims-to-properties.md`** — convert each expressible Claim 1:1
   into a Correctness_Property test file, record inexpressible Claims as
   unverifiable with a reason, handle embedded React component logic, and record
   an immutable Predicted_Result locked before execution (R3, R4).
5. **`steering/04-execute-and-revive.md`** — delegate execution to the MCP tools,
   read the comparison, and generate at least one Fix_Task per Confirmed_Bug
   applied only to the Target_Repo_Copy (R8).
6. **`steering/05-artifact-formats.md`** — the exact on-disk formats and
   directory layout every artifact above must be written in. This is the single
   source of truth for file shapes; the other steering files reference it.

## Artifact formats are defined, not invented

Every artifact this Power writes uses the on-disk formats defined by the shared
types package (`@spec-lantern/types`, module `artifacts.ts`) and summarized in
`steering/05-artifact-formats.md`. Do not invent parallel JSON shapes, filename
conventions, or directory layouts. Downstream tooling — the Validator and the
prediction-lock tool — reads these exact formats back from disk.

## The MCP_Server comes with this Power

This Power ships an `mcp.json` beside this `POWER.md`. Installing the Power
registers the `spec-lantern` MCP server (a Node stdio process,
`packages/mcp-server/dist/bin/server.js`), which exposes the four tools the
pipeline drives:

- `lock_prediction` — lock each Predicted_Result before execution (R3.4, R3.5).
- `execute_properties` — run the Correctness_Properties in the Isolated_Runner.
- `apply_fixes_and_reexecute` — the Revive loop on the Target_Repo_Copy.
- `replay_counterexample` — reproduce a Counterexample under its Execution_Context.

Build the server once with `npm run build -w @spec-lantern/mcp-server` so
`dist/bin/server.js` exists. The workspace also registers the same server in
`.kiro/settings/mcp.json` for development. After the server is listed, confirm
Kiro sees all four tools before starting the pipeline.

## Execution is always delegated

This Power produces artifacts and calls MCP tools. It contains no runner and no
execution logic. The MCP_Server owns the Isolated_Runner boundary. Whenever a
property must be run, a fix must be applied and re-run, or a counterexample must
be replayed, call the corresponding MCP tool and read its structured result —
never execute the target yourself.
