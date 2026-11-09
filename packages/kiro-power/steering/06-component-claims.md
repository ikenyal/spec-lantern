---
inclusion: always
---

# 06 — Component claims: render in jsdom and assert on the DOM (R4.1, R4.2, R4.3)

A `component_rendered` Correctness_Property renders a **props-driven** React
component headlessly and asserts on what it actually renders. The property file
does the rendering itself — the runner does not render the component for you, so
the file must set up its own DOM environment, clock, and interactions. Get these
four things right or the run fails as a harness error instead of a clean verdict.

Only author a component property for a **props-driven** component (data arrives
via props). An internally-fetching component is recorded `unverifiable`
(`03-claims-to-properties.md`, R3.6) and gets no property.

## The four things every component property MUST do

1. **Opt into jsdom with a per-file pragma — the FIRST line of the file.**

   ```ts
   // @vitest-environment jsdom
   ```

   The runner runs each property under the default `node` environment and adds
   nothing to it. Without this pragma the first touch of `document`/`window`
   throws `ReferenceError: document is not defined` and the run is reported as
   an EXECUTION_ERROR telling you to add exactly this line. The pragma must be a
   real comment on line 1 (before any import), or Vitest ignores it.

2. **Pin the clock to the fixed time inside each fast-check iteration.** A
   component that reads `new Date()`/`Date.now()` must render deterministically.
   Use `vi.useFakeTimers()` + `vi.setSystemTime(now)` inside the property body
   (and restore real timers in `finally`/`afterEach`). Build `now` from the
   generated input so every iteration is reproducible; never read the host wall
   clock. `TZ` is pinned by the runner, but set `process.env.TZ = "UTC"` at the
   top too so the file is self-consistent when run directly.

3. **Activate Radix-style controls with the runner's `activateTab` helper.**
   Radix UI primitives (Tabs, Select, Dropdown, ...) switch on
   `pointerdown`/`mousedown` AND expect the jsdom Pointer Capture API, not a bare
   synthetic `click`. The combination that reliably mounts a Radix `TabsContent`
   in jsdom is: install the pointer-capture shims, then FOCUS the trigger, send a
   KEYBOARD activation, fire the POINTER sequence, then CLICK. **Do not rebuild
   that sequence by hand** — the runner shim already installs the pointer-capture
   shims and exposes two globals you call directly:

   - `activateTab("Monthly")` — find the tab trigger by its accessible name and
     run the full proven sequence. This is the one to reach for.
   - `activate(element)` — the lower-level form when you already hold the element.

   (These are `activateTabByName`/`activateElement` in the runner's
   `component-render.ts`, embedded verbatim into the render shim, and covered by a
   jsdom unit test that renders a real Radix Tabs and asserts a previously
   unmounted `TabsContent` becomes queryable after `activateTab`.) It took four
   manual attempts to discover this exact combination; use the helper and skip
   the rediscovery.

4. **Query safely, then assert explicitly.** Never let a missing element throw a
   raw harness error. Use `queryAll*` (which returns `[]` rather than throwing),
   check what you got with an `expect(...)` that carries a message, and only then
   read the value you assert on. A missing element then becomes a readable
   assertion FAIL ("expected a data row, found none"), not an opaque crash the
   runner must classify as an execution error.

## Render ONCE outside the generated-input loop when the claim is input-independent

If the claim you are verifying does NOT depend on the generated inputs — e.g. a
claim about tab ORDERING, which panel is shown first, or which control is
labelled "latest" — render the component and activate the tab ONCE, OUTSIDE the
`fc.assert` loop (in a `beforeAll`, or just before `fc.assert`), and only QUERY
the already-rendered DOM inside the property. Re-rendering and re-activating a
real component on every one of the ≥100 fast-check iterations is pure overhead
when the DOM does not change with the input, and it is the slow path that pushes
component properties into `TIMEOUT`.

When the asserted value IS derived from the generated input (a date the
component formats, a count it sums), render inside the loop as the template
shows and pin the clock per iteration. The rule is: render where the thing you
assert on actually varies, and no more often than that.

## NEVER report a FAIL that is only "content not mounted" — that is a HARNESS bug

A Radix tab panel that is not mounted is NOT a Confirmed_Bug. Radix unmounts
inactive `TabsContent` by default, so if you query for a panel's content before
activating its tab you will find nothing — and that absence is a property of
YOUR harness not having activated the tab, not a lie in the target's code. If a
property FAILs or errors only because the panel it reads was never mounted:

- Fix it by calling `activateTab("<name>")` (above) before the query. Do not
  weaken the oracle, and do not record the absence as a counterexample.
- A genuine FAIL is one where the tab WAS activated (its content IS mounted and
  queryable) and the rendered value still contradicts the claim. Only that is a
  Confirmed_Bug worth a counterexample.

Treat an empty `queryAll*` after a correct `activateTab` as a signal to check the
accessible name you passed and the activation, not as a verdict.

## Helpers the runner already provides — rely on them, don't rebuild them

The runner wires two common testing-library helpers into the test phase, so you
do NOT need to register matchers or install anything yourself:

- **`@testing-library/jest-dom` matchers are already registered.** DOM matchers
  such as `toHaveAttribute`, `toBeInTheDocument`, `toHaveTextContent`, and
  `toHaveClass` work out of the box — just call them on `expect(...)`. (They used
  to fail with "Invalid Chai property" because the package was installed but
  never registered; the generic execute path now registers them for you.) Do NOT
  add your own `import "@testing-library/jest-dom"` / `expect.extend(...)` — it
  is redundant.
- **`@testing-library/user-event` is available.** `import userEvent from
  "@testing-library/user-event"` resolves inside the runner (it is part of the
  pinned toolchain fetched during the install phase). Use it for realistic
  pointer/keyboard interactions when `fireEvent` is not enough. Note that under
  the pinned fake clock you must advance timers for user-event's delays, or
  create it with `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`.

Both are fetched through the same registry proxy during the install phase; the
no-network test phase never installs, so do not add them to the property file as
if they were missing.

The recorded fixed clock is also applied for you: `new Date()`/`Date.now()`
return the recorded Fixed_Current_Time on the generic execute path even before
you call `vi.useFakeTimers()` yourself, so a component that reads the clock
renders deterministically. Pinning your own clock per iteration (below) still
takes precedence and is the right thing to do when the asserted date is derived
from the generated input.

### Do NOT use `waitFor` under fake timers without the bridge

`@testing-library`'s `waitFor` polls on real timers unless it detects a
jest-style fake-timer global. Under the pinned clock (`vi.useFakeTimers()`) that
polling never advances, so `waitFor` HANGS until it hits its own timeout on
every iteration — which looks like a `TIMEOUT` verdict, not a bug in the target.
The template handles this in two ways; keep both:

- It installs a one-line `globalThis.jest` bridge so `waitFor` can drive the
  fake clock (`advanceTimersByTime` → `vi.advanceTimersByTime`).
- It also activates the control and reads the DOM **synchronously** (Radix Tabs
  switch synchronously in jsdom), so the common case needs no `waitFor` at all.
  Prefer the synchronous read; reach for `waitFor` only for genuinely async UI,
  and only with the bridge in place.

## Assertions still follow the oracle rules

Everything in `03-claims-to-properties.md` still applies: assert the **intended**
behavior the comment promises, use a minimum of 100 fast-check iterations, build
the expected value from an independent source (never the component's own
output), and terminate with exactly one PASS/FAIL. Use a plain
`expect(...).toBe(...)`/`.toEqual(...)` so a real violation is a VERDICT FAIL
(AssertionError), never a thrown Error.

## File extension and JSX

Keep the `property-{n}.{claimId}.test.ts` stem (the 1:1 Claim→property→prediction
filename). Because it is a `.ts` file, build elements with
`React.createElement(Component, props)` rather than JSX syntax, which is
ambiguous in `.ts`.

## Importing the component

Import the component the same way `03-claims-to-properties.md` describes: prefer
the target's `@/...` alias (the runner preserves it) — e.g.
`import PeriodProgressSummary from "@/components/statistics/PeriodProgressSummary"`.
If the component's module graph statically imports an internal backend client
(e.g. Supabase) that you do not need for a props-driven render, you may add a
one-line `vi.mock("@/integrations/supabase/client", () => ({ /* inert */ }))` at
the top — mock ONLY that unrelated dependency, never the component under test.

## Template — copy this, then fill in the four TODOs

```ts
// @vitest-environment jsdom
// Feature: spec-lantern, Property {n}: {property_text}
//
// Claim: "{verbatim comment text}" ({relative/path/to/Component.tsx}:{line})
// Prediction (read-only, before execution): {PASS|FAIL} — {one line of reasoning}
//
// Renders the REAL component in jsdom and asserts on the rendered DOM. The four
// must-dos (see steering 06): the jsdom pragma above, a clock pinned per
// iteration, Radix activation via a real pointer sequence, and safe queries +
// explicit assertions so a missing element is a readable FAIL, not a crash.

import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import fc from "fast-check";

// Import the REAL component under test via the target's "@" -> src alias.
import Component from "@/TODO/path/to/Component";

// Self-consistent zone when run directly; the runner also pins TZ.
process.env.TZ = "UTC";

// The runner shim already installs globalThis.jest (the waitFor fake-timer
// bridge), the jsdom pointer-capture shims, and the global activate(element) /
// activateTab(name) helpers encoding the proven focus+keyboard+pointer+click
// sequence. Call activateTab("<tab name>") to mount a Radix TabsContent — do NOT
// rebuild the pointer sequence by hand here.

afterEach(() => {
  // Tear down the tree and restore the real clock so one iteration cannot leak
  // DOM or fake timers into the next.
  cleanup();
  vi.useRealTimers();
});

test("{property_text}", async () => {
  await fc.assert(
    fc.asyncProperty(
      // TODO 1: a smart generator over the WHOLE documented input space (e.g.
      // a plausible "now" and the props the component renders from).
      fc.record({
        year: fc.integer({ min: 2000, max: 2100 }),
        month: fc.integer({ min: 0, max: 11 }),
        day: fc.integer({ min: 1, max: 28 }),
      }),
      async ({ year, month, day }) => {
        const now = new Date(year, month, day, 12, 0, 0);

        // Pin the clock the component reads via new Date().
        vi.useFakeTimers();
        vi.setSystemTime(now);
        try {
          // TODO 2: inject the mocked data via props (props-driven only).
          render(createElement(Component, { /* ...props */ }));

          // TODO 3: if the claim is behind a Radix tab/select, activate it with
          // the runner's helper. Radix Tabs switch SYNCHRONOUSLY in jsdom, so no
          // waitFor is needed. For an input-INDEPENDENT claim render + activate
          // ONCE outside this loop instead (see "Render ONCE ...").
          // activateTab("Monthly");

          // TODO 4: read the asserted value with SAFE queries + explicit checks
          // so a missing element is a readable assertion FAIL, not a crash.
          const panels = screen.queryAllByRole("tabpanel");
          expect(panels.length, "expected the active tabpanel to render").toBeGreaterThan(0);
          const rows = within(panels[0]).queryAllByRole("row");
          // rows[0] is the header; the first DATA row is rows[1].
          expect(rows.length, "expected at least one data row").toBeGreaterThan(1);
          const cells = within(rows[1]).queryAllByRole("cell");
          expect(cells.length, "expected the data row to have cells").toBeGreaterThan(0);
          const value = (cells[0].textContent ?? "").trim();
          expect(value.length, "expected the first cell to be populated").toBeGreaterThan(0);

          // Build `expected` from an INDEPENDENT source (never the component's
          // own output). Assert the INTENDED behavior the comment promises.
          const expected = /* TODO: independent expected value from `now` */ "";
          expect(
            value,
            `expected first row: ${expected}, actual first row: ${value}`,
          ).toBe(expected);
        } finally {
          cleanup();
          vi.useRealTimers();
        }
      },
    ),
    { numRuns: 100 },
  );
});
```

## Component renders are slower — give them timeout headroom

Rendering a real component in jsdom for ≥100 fast-check iterations is much
heavier than a plain function property, and the FIRST run also installs the
target's full dependency tree. If `execute_properties` returns `TIMEOUT` for a
component property (the default test-phase ceiling is 30s), re-run it with a
larger `timeoutSeconds` (e.g. `180`). This only raises the no-network test-phase
ceiling; it does not weaken any safety boundary.

## Output of this step

- One `property-{n}.{claimId}.test.ts` per props-driven component Claim, built
  from the template above, alongside the function properties from step 03.
- Its locked Predicted_Result, exactly as step 03 requires.
