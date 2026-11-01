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
— the first monthly row is the current month — by exercising the **REAL**
`PeriodProgressSummary` component (it does NOT reproduce `getPeriods()` inline).
It is tagged `Feature: spec-lantern, Property 1: ...`, runs a minimum of 100
fast-check iterations, and terminates with exactly one of PASS or FAIL.

How it exercises the real component:

- **Import via the `@` alias.** `import PeriodProgressSummary from
  "@/components/statistics/PeriodProgressSummary"`. The `@` → `./src` alias is
  supplied by the working-copy vitest config that task 4.3 drops next to a copy
  of writing-tracker (so `@/components/ui/*`, the `Book` service, and its
  transitive `@/integrations/supabase/client` all resolve against the working
  copy's own `node_modules` inside the container). The property never imports
  from `sandbox/` directly.
- **Render in jsdom** with `@testing-library/react` (`render` +
  `createElement`; the file keeps its `.test.ts` stem so it uses
  `React.createElement` instead of JSX).
- **Generate inputs** with fast-check (≥100 runs): a plausible "now" instant
  (year 2000–2100, month 0–11, day 1–28) and a possibly-empty `books: Book[]`
  array passed via props.
- **Pin the clock.** `getPeriods()` calls `new Date()` directly (host clock), so
  each run does `vi.useFakeTimers()` + `vi.setSystemTime(now)` and sets
  `process.env.TZ = "UTC"` so month boundaries are deterministic; timers are
  restored after each run.
- **Switch to Monthly and read the first row.** It clicks the "Monthly"
  `TabsTrigger` (Radix activates the monthly `TabsContent` via `onValueChange`),
  waits for the active tabpanel, then reads the first data row's first cell —
  the Month-column label — using role-based queries scoped to the tabpanel.
- **Assert the intended behavior:** the first row label equals
  `` `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}` `` (the current
  month). On the real buggy code the first row is the OLDEST month, so this
  assertion FAILS — which is exactly what the walking skeleton is meant to
  expose. (Authoring the correct, runnable property is task 4.1; running it in
  the container and observing the FAIL is task 4.3.) The assertion is a plain
  `expect().toBe()` (an AssertionError, not a thrown Error) with a custom
  message that spells out the rendered-vs-expected first row in words, e.g.
  `expected first row: Jan 2000, actual first row: Aug 1999`, so the runner
  (task 4.2) classifies the ordering violation as VERDICT FAIL while
  render/query failures still propagate as throws/timeouts (EXECUTION_ERROR /
  TIMEOUT).

## The prediction

`property-1.claim-monthly-order.predicted.json` is the read-only, comment-trusting
prediction: `PASS` with a pre-execution `recordedAt` timestamp and
`immutable: true`. The point of the product is that EXECUTION contradicts this
PASS — tasks 4.2/4.3 run the property in the runner and observe FAIL with a
counterexample (e.g. "now" = Jan 2000 → first row `Aug 1999`, not `Jan 2000`).

## Running the property

These tests live OUTSIDE the host CI suite (the root `vitest.config.ts` only
includes `packages/**/src/**`) because they are meant to run inside the runner
against writing-tracker.

Because the property now imports the **real** component through the `@` → `src`
alias and renders it in **jsdom**, it can NOT be run directly against this
skeleton directory — there is no `@` alias or jsdom environment here, and the
real-component import (and its transitive `@/integrations/supabase/client`
dependency) only resolves inside a copy of writing-tracker with its own
`node_modules`. That is exactly what task 4.3 stands up: it copies
`sandbox/writing-tracker` into a gitignored working dir, writes a vitest config
there providing the `@` → `src` alias + the `jsdom` environment +
`@testing-library/react` (and friends), drops this property file into the
working copy, and runs it **inside the container**.

So the property is authored to be self-consistent with that plan — import via
`@`, render in jsdom, pin the clock with Vitest fake timers + `TZ=UTC` — and the
container (task 4.3), not the host, executes it. The host
`vitest.skeleton.config.ts` remains only as the include-glob marker that keeps
these files discoverable and out of host CI.

Expected result when task 4.3 runs it in the container: FAIL with a
counterexample, proving execution contradicts the comment-trusting PASS
prediction (e.g. "now" = Jan 2000 → first row `Aug 1999`, not `Jan 2000`).
