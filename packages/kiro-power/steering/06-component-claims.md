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

3. **Activate Radix-style controls with a real pointer sequence.** Radix UI
   primitives (Tabs, Select, Dropdown, ...) switch on `pointerdown`/`mousedown`,
   not a bare synthetic `click`. Fire the pointer events before the click (the
   `activate()` helper in the template does this) or the control never changes
   in jsdom and your query finds the wrong panel.

4. **Query safely, then assert explicitly.** Never let a missing element throw a
   raw harness error. Use `queryAll*` (which returns `[]` rather than throwing),
   check what you got with an `expect(...)` that carries a message, and only then
   read the value you assert on. A missing element then becomes a readable
   assertion FAIL ("expected a data row, found none"), not an opaque crash the
   runner must classify as an execution error.

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

// Bridge so @testing-library's waitFor can drive Vitest fake timers instead of
// hanging on a frozen clock (see "Do NOT use waitFor under fake timers").
globalThis.jest = { advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms) };

// Radix primitives activate on pointerdown/mousedown, not a bare click. Fire the
// pointer sequence a real pointer click would, then the click.
function activate(element: Element): void {
  fireEvent.pointerDown(element);
  fireEvent.mouseDown(element);
  fireEvent.click(element);
}

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

          // TODO 3: if the claim is behind a Radix tab/select, activate it.
          // Radix Tabs switch SYNCHRONOUSLY in jsdom, so no waitFor is needed.
          // activate(screen.getByRole("tab", { name: "Monthly" }));

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
