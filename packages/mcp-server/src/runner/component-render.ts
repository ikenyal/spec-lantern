/**
 * jsdom component rendering under a Controllable_Clock (task 12.1).
 *
 * This module is the GENERIC render harness for `component_rendered`
 * Correctness_Properties (design Component 3: *"Host the Vitest + jsdom harness;
 * inject mocked data and a Controllable_Clock when evaluating embedded component
 * logic (R4.2, R4.3)"*). It is the factored-out, target-agnostic version of the
 * render plumbing the walking skeleton ({@link ../execute-path.ts}) first grew
 * for writing-tracker's one monthly-ordering property. The skeleton hard-coded
 * that plumbing in `WORKTREE_VITEST_CONFIG` / `WORKTREE_SETUP` /
 * `WORKTREE_SUPABASE_STUB`; those are now thin wrappers around the builders
 * here so there is ONE render harness, not two divergent copies.
 *
 * WHAT A `component_rendered` PROPERTY NEEDS (R4.2, R4.3):
 *
 *  1. **jsdom + the target's `@` → `src` alias.** A React component is rendered
 *     headlessly with `@testing-library/react`, and its `@/...` imports must
 *     resolve against the target's own `src`. {@link buildComponentRenderVitestConfig}
 *     emits a `vitest.config.ts` that supplies the `@` alias + the `jsdom`
 *     environment + a `setupFiles` entry, exactly as the skeleton's config did,
 *     but parameterized over the target so any props-driven component renders.
 *
 *  2. **Mocked data injected via props (R4.2).** The component is PROPS-DRIVEN:
 *     the `CorrectnessProperty.embeddedComponentLogic.mockedData` is passed to
 *     the component as props. The authored property file reads the component via
 *     the `@` alias and renders it; the harness only has to make that import
 *     resolve and the DOM queryable. (A component that fetches its own data
 *     internally is NOT rendered — see the unverifiable guard below.)
 *
 *  3. **A Controllable_Clock pinned to Fixed_Current_Time + fixed `TZ` (R4.3).**
 *     A time-dependent component that reads `new Date()`/`Date.now()` must
 *     render deterministically. {@link buildControllableClockSetupModule} emits
 *     an OPT-IN setup module that, when the component-render config wires it,
 *     installs Vitest fake timers pinned to the recorded Fixed_Current_Time
 *     (read from {@link FIXED_TIME_ENV}, already threaded into the container by
 *     {@link ./execution-context.ts}) and re-asserts the pinned `TZ`.
 *
 * WHY THE CLOCK IS OPT-IN, NOT GLOBAL. The shared execution-context setup
 * ({@link ./execution-context.ts}) deliberately does NOT force fake timers
 * globally: the walking-skeleton property manages its OWN clock per fast-check
 * iteration (`vi.useFakeTimers()` + `vi.setSystemTime(now)`), and forcing a
 * global clock would fight it. So the Controllable_Clock lives in a SEPARATE
 * setup module that only the component-render config wires in, and even then it
 * installs the fake clock in a way that a property which takes over its own
 * clock simply overrides. The walking skeleton never goes through this module,
 * so its self-managed clock path is untouched and its smoke test keeps its SAME
 * FAIL + counterexample.
 *
 * THE UNVERIFIABLE PATH (R3.6, R4.1): render NOTHING for internally-fetching
 * components. Only PROPS-DRIVEN components are rendered. A Claim whose embedded
 * logic lives in a component that fetches its own data internally is recorded
 * `unverifiable` by the Kiro_Power and carries NO `component_rendered` property
 * (see `Claim.unverifiable`, R3.6). {@link planComponentRender} enforces this at
 * the render boundary: a property that is not a props-driven `component_rendered`
 * property (wrong `kind`, or missing `embeddedComponentLogic`) yields a
 * {@link ComponentRenderPlan} of `{ render: false }` so the harness renders
 * nothing. This is belt-and-suspenders for the Kiro_Power's authoring-time rule:
 * even if an internally-fetching Claim slipped through as a property, the
 * render boundary refuses to render it.
 *
 * PURITY + TESTABILITY. Every builder here is a pure string/record function with
 * no I/O, mirroring {@link ./execution-context.ts}, so the harness is
 * unit-testable without a container and the test-phase stager owns the actual
 * file writes. {@link ./test-phase.ts} (and the walking-skeleton execute path)
 * write these strings into the single mounted working directory.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorrectnessProperty } from "@spec-lantern/types";
import { FIXED_TIME_ENV, TIMEZONE_ENV } from "./execution-context.js";

/* -------------------------------------------------------------------------- */
/* Canonical file names written into the mount for a component render         */
/* -------------------------------------------------------------------------- */

/**
 * File name of the Controllable_Clock Vitest setup module. Dotfile-prefixed and
 * scoped to spec-lantern so it never collides with a target's own files, and it
 * lives UNDER the single mounted working directory (under `/Users` on macOS) so
 * it is visible inside the Podman VM. Wired via `setupFiles` ONLY by the
 * component-render config (never globally), so the Controllable_Clock is opt-in.
 */
export const COMPONENT_RENDER_SETUP_FILE = ".spec-lantern-render-setup.mjs";

/**
 * File name of the reusable DOM-interaction shim module (waitFor fake-timer shim
 * + Radix pointerdown/mousedown click shim). Same dotfile + mount-local
 * discipline as {@link COMPONENT_RENDER_SETUP_FILE}; wired alongside it in the
 * component-render config's `setupFiles`.
 */
export const COMPONENT_RENDER_SHIM_FILE = ".spec-lantern-render-shim.mjs";

/**
 * File name of the inert backend stub the render config aliases internal data
 * clients to, so a props-driven component's module graph resolves without a
 * live backend. (The component under test is still the REAL one; this only
 * satisfies an unrelated client import, exactly like the skeleton's Supabase
 * stub.)
 */
export const COMPONENT_RENDER_BACKEND_STUB_FILE =
  ".spec-lantern-backend-stub.mjs";

/* -------------------------------------------------------------------------- */
/* The render decision (props-driven ⇒ render; else render nothing)           */
/* -------------------------------------------------------------------------- */

/**
 * The decision of whether — and what — to render for a Correctness_Property.
 *
 * A `component_rendered` property that carries `embeddedComponentLogic` is a
 * PROPS-DRIVEN render: {@link planComponentRender} returns `{ render: true }`
 * with the component path and the mocked data to inject via props. Anything else
 * — a `kind: "function"` property, or a `component_rendered` property with no
 * `embeddedComponentLogic` (which is how an internally-fetching Claim would have
 * been recorded unverifiable, R3.6/R4.1) — yields `{ render: false }` so the
 * harness renders NOTHING.
 */
export type ComponentRenderPlan =
  | {
      render: true;
      /** The component to render, as recorded on the property (R4.2). */
      componentPath: string;
      /** The data to inject via props (R4.2). */
      mockedData: unknown;
    }
  | {
      render: false;
      /** Why nothing is rendered (surfaced for diagnostics / the orchestrator). */
      reason: string;
    };

/**
 * Decide whether a Correctness_Property is a props-driven `component_rendered`
 * property that the jsdom harness should render, and what to render (R4.1,
 * R4.2, R3.6).
 *
 * The ONLY renderable shape is a property of `kind: "component_rendered"` that
 * carries `embeddedComponentLogic` (the `componentPath` + the `mockedData`
 * injected via props). Every other shape renders NOTHING:
 *
 *  - A `kind: "function"` property is a plain function property, not a render;
 *    it is executed by the normal test phase, never through this harness.
 *  - A `component_rendered` property with NO `embeddedComponentLogic` cannot be
 *    a props-driven render — it would describe an internally-fetching component,
 *    which the Kiro_Power records as unverifiable with NO property at all
 *    (R3.6/R4.1). Refusing to render it here is the render-boundary
 *    belt-and-suspenders for that authoring-time rule: an internally-fetching
 *    component must never be rendered.
 *
 * Pure: a property always maps to the same plan.
 */
export function planComponentRender(
  property: CorrectnessProperty,
): ComponentRenderPlan {
  if (property.kind !== "component_rendered") {
    return {
      render: false,
      reason:
        `property ${property.id} is kind "${property.kind}", not ` +
        `"component_rendered" — nothing to render in jsdom`,
    };
  }
  const embedded = property.embeddedComponentLogic;
  if (!embedded || !embedded.componentPath) {
    return {
      render: false,
      reason:
        `property ${property.id} is "component_rendered" but carries no ` +
        `props-driven embeddedComponentLogic — an internally-fetching ` +
        `component is recorded unverifiable and is never rendered (R3.6, R4.1)`,
    };
  }
  return {
    render: true,
    componentPath: embedded.componentPath,
    mockedData: embedded.mockedData,
  };
}

/* -------------------------------------------------------------------------- */
/* The Controllable_Clock setup module (R4.3) — OPT-IN, never global          */
/* -------------------------------------------------------------------------- */

/**
 * Build the source of the OPT-IN Controllable_Clock Vitest setup module (R4.3).
 *
 * It runs INSIDE the container before the component renders (wired via the
 * component-render config's `setupFiles`, NEVER the global execution-context
 * config) and pins the clock a time-dependent component reads so rendering is
 * deterministic:
 *
 *  - It re-asserts `process.env.TZ` from {@link TIMEZONE_ENV} defensively (the
 *    test script also exports it) so zone-dependent date math is stable.
 *  - Before each test it installs Vitest fake timers and pins "now" to the
 *    recorded Fixed_Current_Time read from {@link FIXED_TIME_ENV} (the instant
 *    {@link ./execution-context.ts} already threads into the container). A
 *    component that calls `new Date()`/`Date.now()` therefore reads ONE
 *    canonical instant on every render, so the render is deterministic (R4.3).
 *  - After each test it restores real timers so nothing leaks between tests.
 *
 * WHY `beforeEach`/`afterEach` RATHER THAN A ONE-SHOT INSTALL. A property that
 * wants to drive the clock itself (advance it, or pin a different instant per
 * fast-check iteration) can still call `vi.useFakeTimers()` /
 * `vi.setSystemTime(...)` inside its own body — that simply re-pins the already
 * -faked clock and takes precedence for that test. The harness provides a sane
 * deterministic DEFAULT (the recorded Fixed_Current_Time) without preventing a
 * property from managing its own clock.
 *
 * TOLERANCE. If `vitest` cannot be resolved, or the Fixed_Current_Time is
 * absent/unparseable, the module degrades to a no-op (it never throws) so it
 * can never perturb classification: a render that does not read the clock is
 * unaffected, and a missing instant just means no fake clock is pinned.
 */
export function buildControllableClockSetupModule(): string {
  return `// Generated by spec-lantern (task 12.1): the Controllable_Clock for a
// component_rendered property. OPT-IN — wired only by the component-render
// Vitest config, never globally — so a property that manages its own clock
// (e.g. the walking skeleton) is never fought. It pins Vitest fake timers to
// the recorded Fixed_Current_Time so a time-dependent render is deterministic
// (R4.3). Loaded via \`setupFiles\` before the component renders.
const tz = process.env[${JSON.stringify(TIMEZONE_ENV)}];
if (tz) {
  process.env.TZ = tz;
}
const fixedRaw = process.env[${JSON.stringify(FIXED_TIME_ENV)}];
const fixedInstant = fixedRaw ? new Date(fixedRaw) : undefined;
const hasFixedInstant =
  fixedInstant !== undefined && !Number.isNaN(fixedInstant.getTime());
try {
  const { beforeEach, afterEach, vi } = await import("vitest");
  if (hasFixedInstant) {
    // Pin the Controllable_Clock to the recorded Fixed_Current_Time before each
    // render so \`new Date()\`/\`Date.now()\` are deterministic (R4.3). A property
    // that re-pins its own clock in its body overrides this default.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(fixedInstant);
    });
    afterEach(() => {
      // Restore real timers so no faked clock leaks into the next test.
      vi.useRealTimers();
    });
  }
} catch {
  // vitest unresolvable (not a Vitest run) — the Controllable_Clock is a no-op.
  // Never perturb classification.
}
`;
}

/* -------------------------------------------------------------------------- */
/* The inert backend stub (module-graph resolution for a props-driven render) */
/* -------------------------------------------------------------------------- */

/**
 * Build the source of the inert backend-client stub the component-render config
 * aliases an internal data client to, so a props-driven component's module graph
 * resolves without a live backend.
 *
 * This is the generalized form of the walking skeleton's Supabase stub: it mocks
 * ONLY an unrelated backend dependency, NEVER the component under test or its
 * logic. A props-driven component receives all the data it renders via props
 * (R4.2); if its module graph still statically imports a backend client (even a
 * type-only import that is normally elided), this stub satisfies that import. If
 * the stub's client is ever actually CALLED at runtime it throws loudly, which
 * surfaces as an honest EXECUTION_ERROR — a component that genuinely needs the
 * backend at render time is internally-fetching and should have been recorded
 * unverifiable (R3.6/R4.1), not rendered.
 */
export function buildBackendClientStubModule(): string {
  return `// Generated by spec-lantern (task 12.1): an inert backend-client stub so a
// PROPS-DRIVEN component's module graph resolves without a live backend. It
// mocks ONLY an unrelated backend dependency, never the component under test.
// A props-driven component gets its data via props (R4.2); if it actually CALLS
// this client at render time it is internally-fetching (recorded unverifiable,
// R3.6) and the loud throw surfaces as an honest EXECUTION_ERROR.
export const client = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "spec-lantern stub: an internal backend client is not available inside " +
          "the Isolated_Runner. A component_rendered property must be " +
          "props-driven (R4.2); an internally-fetching component is recorded " +
          "unverifiable (R3.6), not rendered.",
      );
    },
  },
);
export const supabase = client;
export default client;
`;
}

/* -------------------------------------------------------------------------- */
/* The DOM-interaction shims (waitFor + Radix) — reusable render plumbing      */
/* -------------------------------------------------------------------------- */

/**
 * Build the source of the DOM-interaction shim module — the reusable render
 * PLUMBING a jsdom render needs that is independent of any one target. It
 * patches two gaps that only appear when rendering a real component in jsdom,
 * and it NEVER touches a property's assertion:
 *
 *  1. `waitFor` + fake timers. `@testing-library`'s `waitFor` polls on real
 *     timers unless it detects a jest-style fake-timer global; under the
 *     Controllable_Clock (Vitest fake timers) its polling would otherwise freeze
 *     and hang the render. A minimal `jest` shim proxying `advanceTimersByTime`
 *     to `vi` lets `waitFor` drive the fake clock forward.
 *
 *  2. Radix activation. Radix UI primitives (Tabs, Select, etc.) activate on
 *     pointerdown/mousedown, not a bare synthetic `click`. The shim makes
 *     `fireEvent.click` first dispatch the pointerdown/mousedown Radix listens
 *     for, exactly as a real pointer click would, so a property that clicks a
 *     Radix control switches it in jsdom.
 *
 * This is the generalized form of the walking skeleton's `WORKTREE_SETUP`. It is
 * emitted as its OWN module so it composes with the Controllable_Clock setup —
 * both are listed in the component-render config's `setupFiles`. It is tolerant:
 * if `@testing-library/react` is unresolvable the Radix shim is skipped rather
 * than crashing the run.
 */
export function buildDomInteractionShimModule(): string {
  return `// Generated by spec-lantern (task 12.1): reusable jsdom render PLUMBING.
// (1) make waitFor cooperate with Vitest fake timers; (2) make fireEvent.click
// emit the pointerdown/mousedown Radix primitives activate on. Never touches a
// property's assertion. Loaded via \`setupFiles\`.
import { vi } from "vitest";

// (1) Make waitFor cooperate with Vitest fake timers (the Controllable_Clock).
globalThis.jest = {
  advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms),
};

// (2) Radix primitives activate on pointerdown/mousedown, not a bare click.
try {
  const { fireEvent } = await import("@testing-library/react");
  const originalClick = fireEvent.click.bind(fireEvent);
  fireEvent.click = (element, init) => {
    if (element instanceof Element) {
      fireEvent.pointerDown(element, init);
      fireEvent.mouseDown(element, init);
    }
    return originalClick(element, init);
  };
} catch {
  // @testing-library/react not resolvable — the Radix shim is a no-op.
}
`;
}

/* -------------------------------------------------------------------------- */
/* The component-render Vitest config (jsdom + the target's @ -> src alias)    */
/* -------------------------------------------------------------------------- */

/**
 * Options for {@link buildComponentRenderVitestConfig}. All paths are POSIX,
 * relative to the mount root (the caller resolves them), so this stays a pure
 * string builder and the config is relocatable with the mount.
 */
export interface ComponentRenderVitestConfigOptions {
  /**
   * POSIX-relative path (from the mount root) to the target's `src` directory,
   * which the `@` alias points at so the component's `@/...` imports resolve.
   * Defaults to `./src` (the overwhelmingly common Vite/React convention and
   * the writing-tracker layout).
   */
  srcDirRel?: string;
  /**
   * POSIX glob (relative to the mount root) selecting the property test file(s)
   * to run. The authored `component_rendered` property file lands under `src`
   * so its own `@/...` imports resolve like the component's.
   */
  includeGlob: string;
  /**
   * Regex SOURCE strings (the body of a `new RegExp(...)`, without delimiters)
   * matching internal backend-client import specifiers to alias to the inert
   * stub, so a props-driven component's module graph resolves without a live
   * backend. Defaults to the common Supabase client path. Each is matched
   * before the general `@/` alias so the specific rule wins.
   */
  backendClientSpecifierPatterns?: string[];
}

/**
 * Build the source of the component-render `vitest.config.ts` written into the
 * mount. It is the generalized form of the walking skeleton's
 * `WORKTREE_VITEST_CONFIG`: it supplies the `@` → `src` alias so the component's
 * `@/...` imports resolve, sets the `jsdom` environment so
 * `@testing-library/react` can render + query, wires BOTH render setup modules
 * (the DOM-interaction shims AND the opt-in Controllable_Clock), includes the
 * property file(s), and aliases internal backend clients to the inert stub.
 *
 * It resolves paths relative to the config file so the working copy is
 * relocatable, mirroring the skeleton config. The alias ORDER matters: the
 * specific backend-client rules come BEFORE the general `@/` rule so the
 * backend stub wins for those specifiers. Generous test/hook timeouts are kept
 * because the first container run installs the full dependency tree before the
 * property's ≥100 fast-check iterations.
 */
export function buildComponentRenderVitestConfig(
  options: ComponentRenderVitestConfigOptions,
): string {
  const srcDirRel = options.srcDirRel ?? "./src";
  const includeGlob = options.includeGlob;
  const backendPatterns =
    options.backendClientSpecifierPatterns ?? [
      String.raw`^@/integrations/supabase/client$`,
    ];

  // Build the backend-client alias entries (most specific first). Each regex
  // source is embedded verbatim into a `new RegExp(...)` in the emitted config.
  const backendAliasEntries = backendPatterns
    .map(
      (pattern) =>
        `      {\n` +
        `        find: new RegExp(${JSON.stringify(pattern)}),\n` +
        `        replacement: backendStub,\n` +
        `      },`,
    )
    .join("\n");

  return `import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Generated by spec-lantern (task 12.1): the GENERIC jsdom component-render
// config for a props-driven component_rendered property (R4.2, R4.3). Resolve
// paths relative to this config file so the working copy is relocatable.
const rootDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(rootDir, ${JSON.stringify(srcDirRel)});
const backendStub = resolve(rootDir, ${JSON.stringify(
    `./${COMPONENT_RENDER_BACKEND_STUB_FILE}`,
  )});

export default defineConfig({
  resolve: {
    alias: [
      // Inert backend-client stub(s) so a props-driven component's module graph
      // loads without a live backend. These mock ONLY unrelated backend
      // dependencies, never the component under test. Listed BEFORE the general
      // "@/" rule so the specific specifier wins.
${backendAliasEntries}
      // The project's own "@" -> src alias (AFTER the specific rules above).
      { find: /^@\\//, replacement: srcDir + "/" },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    // Both render setup modules: the reusable DOM-interaction shims AND the
    // OPT-IN Controllable_Clock pinned to the recorded Fixed_Current_Time (R4.3).
    // The shim runs first so its fake-timer bridge is in place before the clock.
    setupFiles: [
      ${JSON.stringify(`./${COMPONENT_RENDER_SHIM_FILE}`)},
      ${JSON.stringify(`./${COMPONENT_RENDER_SETUP_FILE}`)},
    ],
    include: [${JSON.stringify(includeGlob)}],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // The first container run installs React + the component's deps + the test
    // toolchain; give the single property generous headroom for its >=100
    // fast-check iterations.
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
`;
}

/* -------------------------------------------------------------------------- */
/* Staging the render harness into a mount (the concrete I/O seam)            */
/* -------------------------------------------------------------------------- */

/**
 * File name of the generated component-render Vitest config written at the
 * mount root. Named `vitest.config.ts` so the in-container Vitest auto-detects
 * and prefers it over the target's own `vite.config.ts` (which may import
 * dev-only plugins we don't want in-container), matching the walking skeleton's
 * convention.
 */
export const COMPONENT_RENDER_CONFIG_FILE = "vitest.config.ts";

/** Options for {@link stageComponentRenderHarness}. */
export interface StageComponentRenderHarnessOptions {
  /** The single mounted working directory to write the harness into (host view). */
  mountRoot: string;
  /**
   * POSIX glob (relative to the mount root) selecting the authored
   * `component_rendered` property test file(s) to run. Forwarded to the
   * generated config's `include`.
   */
  includeGlob: string;
  /**
   * POSIX-relative path to the target's `src` dir the `@` alias points at.
   * Defaults to `./src`. Forwarded to the generated config.
   */
  srcDirRel?: string;
  /**
   * Regex SOURCE strings for internal backend-client specifiers to alias to the
   * inert stub. Defaults to the common Supabase client path. Forwarded to the
   * generated config.
   */
  backendClientSpecifierPatterns?: string[];
}

/**
 * Write the GENERIC jsdom component-render harness into the single mounted
 * working directory so the in-container Vitest renders a props-driven
 * `component_rendered` property under the Controllable_Clock (R4.2, R4.3):
 *
 *  - the DOM-interaction shim module ({@link COMPONENT_RENDER_SHIM_FILE}),
 *  - the OPT-IN Controllable_Clock setup module ({@link COMPONENT_RENDER_SETUP_FILE}),
 *  - the inert backend-client stub ({@link COMPONENT_RENDER_BACKEND_STUB_FILE}),
 *  - the generated component-render Vitest config ({@link COMPONENT_RENDER_CONFIG_FILE})
 *    merging none of the target's config but supplying the `@` alias + jsdom env
 *    + both setup modules.
 *
 * All files live UNDER the one mounted dir (under `/Users` on macOS, visible in
 * the Podman VM) and are dotfile-scoped (except the config, which is the
 * conventional `vitest.config.ts`) so they never collide with the target's own
 * files. Returns a cleanup that removes every file it wrote so nothing leaks
 * between runs.
 *
 * This is the I/O seam the execute path / runner call; the string builders above
 * stay pure and unit-testable. It is the generalized counterpart of the walking
 * skeleton's `prepareWorkingCopy` render-file writes.
 */
export async function stageComponentRenderHarness(
  options: StageComponentRenderHarnessOptions,
): Promise<() => Promise<void>> {
  const { mountRoot, includeGlob } = options;

  const shimPath = join(mountRoot, COMPONENT_RENDER_SHIM_FILE);
  const setupPath = join(mountRoot, COMPONENT_RENDER_SETUP_FILE);
  const backendStubPath = join(mountRoot, COMPONENT_RENDER_BACKEND_STUB_FILE);
  const configPath = join(mountRoot, COMPONENT_RENDER_CONFIG_FILE);

  await writeFile(shimPath, buildDomInteractionShimModule());
  await writeFile(setupPath, buildControllableClockSetupModule());
  await writeFile(backendStubPath, buildBackendClientStubModule());
  await writeFile(
    configPath,
    buildComponentRenderVitestConfig({
      srcDirRel: options.srcDirRel,
      includeGlob,
      backendClientSpecifierPatterns: options.backendClientSpecifierPatterns,
    }),
  );

  return async () => {
    await Promise.all(
      [shimPath, setupPath, backendStubPath, configPath].map((p) =>
        rm(p, { force: true }).catch(() => undefined),
      ),
    );
  };
}
