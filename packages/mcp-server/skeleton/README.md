# Walking-skeleton artifacts (task 4.1)

Hand-authored spec-lantern artifacts for the single writing-tracker
monthly-ordering Claim. These are the inputs the minimal Isolated_Runner
(task 4.2) and the thin execute path (task 4.3) consume to execute exactly ONE
Correctness_Property against the writing-tracker Target_Repo and observe a FAIL.

They use the on-disk formats and layout defined in `@spec-lantern/types`
(`src/artifacts.ts`, task 2.2) and the authoring rules from the Kiro_Power
steering (`03-claims-to-properties.md`, `05-artifact-formats.md`, task 3.1).

## Layout

Spec root: `writing-tracker-monthly-order/`

```
writing-tracker-monthly-order/
  claims.json                                              # CLAIMS_FILE_SCHEMA — 1 Claim
  properties/
    property-1.claim-monthly-order.test.ts                 # Correctness_Property (fast-check + Vitest, >=100 runs)
  predictions/
    property-1.claim-monthly-order.predicted.json          # PREDICTED_RESULT_SCHEMA — comment-trusting PASS
```

The 1:1 linkage is discoverable from paths alone: Claim `claim-monthly-order`
→ `property-1.claim-monthly-order.test.ts` → `property-1.claim-monthly-order.predicted.json`
(shared `1.claim-monthly-order` stem). Resolve with `resolveClaimLinkage()` from
`@spec-lantern/types`.

## The Claim

`claim-monthly-order` points at the real misleading comment in the Target_Repo:

- `sourceFile`: `sandbox/writing-tracker/src/components/statistics/PeriodProgressSummary.tsx`
- `commentRef`: `L54 // Reverse to have most recent month first`

The monthly branch of `getPeriods()` builds 6 months as `currentMonth - i`
(i = 0..5, already most-recent-first) then calls `periods.reverse()`, which
actually yields OLDEST month first. The comment promises the opposite.

## The property

`property-1.claim-monthly-order.test.ts` asserts the comment's INTENDED behavior
— the first monthly row is the current month — against a faithful reproduction
of the ordering algorithm. It is tagged
`Feature: spec-lantern, Property 1: ...`, runs a minimum of 100 fast-check
iterations, and terminates with exactly one of PASS or FAIL.

## The prediction

`property-1.claim-monthly-order.predicted.json` is the read-only, comment-trusting
prediction: `PASS` with a pre-execution `recordedAt` timestamp and
`immutable: true`. The point of the product is that EXECUTION contradicts this
PASS — tasks 4.2/4.3 run the property in the runner and observe FAIL with a
counterexample (e.g. "now" = Jan 2000 → first row `Aug 1999`, not `Jan 2000`).

## Running the property locally

These tests live OUTSIDE the host CI suite (the root `vitest.config.ts` only
includes `packages/**/src/**`) because they are meant to run inside the runner
against writing-tracker. To run the skeleton property directly (what the runner
does inside the container):

```sh
cd packages/mcp-server/skeleton
npx vitest run --root "$PWD" --config "$PWD/vitest.skeleton.config.ts"
```

Expected result today: FAIL with a counterexample, proving execution contradicts
the comment-trusting PASS prediction.
