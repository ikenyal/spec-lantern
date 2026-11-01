---
inclusion: always
---

# 05 — On-disk artifact formats (single source of truth)

Every artifact this Power writes uses the **on-disk formats defined in the
shared types package** `@spec-lantern/types`, module `src/artifacts.ts`. Do not
invent parallel JSON shapes, filenames, tags, or directory layouts — the
Validator (task 6) and the prediction-lock tool (task 7) read these exact
formats back from disk. The schemas and path helpers in `artifacts.ts` are
authoritative; this file is a working summary.

## Directory layout

Under a spec root directory:

```
{specRoot}/
  claims.json                                 // CLAIMS_FILE_SCHEMA
  observed-deviations.json                    // OBSERVED_DEVIATIONS_FILE_SCHEMA
  properties/
    property-{n}.{claimId}.test.ts            // one per expressible Claim
  predictions/
    property-{n}.{claimId}.predicted.json     // PREDICTED_RESULT_SCHEMA, one per property
```

The 1:1 linkage is discoverable from paths alone: for a Claim `c`, its property
test file and its prediction file share the same `{n}.{claimId}` stem, so a tool
walks `claims.json` → property file → prediction file with no separate index.
Use the path helpers (`claimsFilePath`, `observedDeviationsFilePath`,
`propertyTestFilePath`, `predictedResultFilePath`, `resolveClaimLinkage`) rather
than hand-building paths.

## `claims.json` (CLAIMS_FILE_SCHEMA)

```json
{
  "claims": [
    {
      "id": "claim-monthly-order",
      "description": "Most recent month is shown first.",
      "sourceFile": "src/components/MonthlyView.tsx",
      "commentRef": "// Reverse to have most recent month first"
    },
    {
      "id": "claim-supabase-feed",
      "description": "The feed lists the user's latest entries.",
      "sourceFile": "src/components/Feed.tsx",
      "commentRef": "// latest entries first",
      "unverifiable": {
        "reason": "Component fetches its own data via the Supabase client; no props-injected data path to render deterministically."
      }
    }
  ]
}
```

- `id`, `description`, `sourceFile`, `commentRef` are all **required and
  non-empty** (R1.3). A Claim with an empty `sourceFile` or `commentRef` is
  invalid.
- `unverifiable.reason` (non-empty) is present only for inexpressible Claims
  (R3.6), including internally-fetching components. An unverifiable Claim emits
  no property file and no prediction file.

## `observed-deviations.json` (OBSERVED_DEVIATIONS_FILE_SCHEMA)

```json
{
  "deviations": [
    {
      "id": "dev-monthly-order",
      "claimId": "claim-monthly-order",
      "claimedBehavior": "Most recent month shown first.",
      "currentBehavior": "Oldest month shown first (periods.reverse on an ascending array)."
    },
    {
      "id": "dev-undeterminable-feed",
      "claimId": "claim-supabase-feed",
      "claimedBehavior": "Feed lists the latest entries.",
      "currentBehavior": null,
      "undeterminable": true
    }
  ]
}
```

- Each entry requires `id`, `claimId` (a valid reference to an existing Claim),
  `claimedBehavior`, and `currentBehavior` (R2.1, R2.2).
- **Empty-list case (R2.3):** when no difference is found, write
  `{ "deviations": [] }`. Zero entries is valid and meaningful.
- **Undeterminable (R2.4):** `undeterminable: true` and `currentBehavior: null`
  travel together — set both or neither. Recording one undeterminable entry must
  not drop other evaluated Claims.

## `properties/property-{n}.{claimId}.test.ts`

The executable property-test-file convention (one per expressible Claim):

1. **Naming** — `property-{n}.{claimId}.test.ts` where `{n}` is the property
   number and `{claimId}` is the Claim id (the id must contain no `.`). Use
   `propertyTestFileName(n, claimId)` / `propertyTestFilePath(...)`.
2. **Location** — under the spec's `properties/` directory, one file per
   property, no more, no less (1:1 with the Claim — R3.1).
3. **Tag** — the file contains the exact comment
   `Feature: spec-lantern, Property {n}: {property_text}` (build with
   `propertyTag(n, text)`).
4. **Termination** — the test terminates with exactly one of PASS or FAIL.
   Timeouts/errors are surfaced by the runner as distinct `ActualResult`
   outcomes, never folded into PASS/FAIL.

Tests use fast-check + Vitest, ≥100 iterations. For a `component_rendered`
property, the test asserts on the component's rendered DOM (rendered by the
MCP_Server in jsdom with injected props and a Controllable_Clock), not on source.

Example skeleton:

```ts
// Feature: spec-lantern, Property 3: the first monthly row is the current month
import { test, expect } from "vitest";
import * as fc from "fast-check";

test("most recent month is first", () => {
  fc.assert(
    fc.property(/* smart generator constrained to the real input space */, (input) => {
      // arrange under the pinned clock/seed supplied via ExecutionContext,
      // assert the intended behavior — terminates PASS or FAIL.
    }),
    { numRuns: 100 },
  );
});
```

## `predictions/property-{n}.{claimId}.predicted.json` (PREDICTED_RESULT_SCHEMA)

```json
{
  "propertyId": "property-3.claim-monthly-order",
  "verdict": "PASS",
  "recordedAt": "2026-11-01T09:00:00.000Z",
  "immutable": true
}
```

- `verdict` is exactly `"PASS"` or `"FAIL"` — never a timeout/error outcome.
- `recordedAt` is an ISO-8601 timestamp recorded **before execution** (R3.4).
- `immutable` is pinned to `true` (R3.5).
- Record the prediction honestly from reading; in the `writing-tracker`
  monthly-ordering example the comment-trusting prediction is `PASS`, which
  execution later contradicts.
- After writing all prediction files, LOCK them with the MCP prediction-lock
  tool before calling `execute_properties`.

## In-memory domain types (for MCP calls)

When constructing MCP tool inputs/outputs, use the serializable domain types
from `@spec-lantern/types` (`src/index.ts`): `CorrectnessProperty`,
`PropertyExecutionRequest`, `PropertyExecutionResult`, `ActualResult`,
`Counterexample`, `ExecutionContext`, `FixTask`, `PropertyTransition`,
`PredictedResult`, `Verdict`. These are the on-the-wire shapes; the JSON files
above are their on-disk persisted form. Keep them consistent — do not introduce
a divergent shape at either boundary.
