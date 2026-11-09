/**
 * Execution_Context recording + deterministic seeding/clock pinning (task 10.3).
 *
 * This module OWNS the determinism-by-construction half of the runner's
 * contract (design "Key Design Decisions": *every execution fixes its
 * Random_Seed, timezone, and Fixed_Current_Time and records them as an
 * Execution_Context so any Counterexample replays to the identical
 * Actual_Result*). It is deliberately separate from {@link ./test-phase.ts} so
 * the seeding/clock-pinning concern (how the Random_Seed is chosen/recorded,
 * how `TZ` and the Fixed_Current_Time are pinned INSIDE the container, and how
 * the recorded {@link ExecutionContext} is threaded back out) is testable in
 * isolation and does not entangle the outcome-classification concern (owned by
 * {@link ./vitest-classify.ts}).
 *
 * WHAT "RECORD AN EXECUTION_CONTEXT PER EXECUTION" MEANS (R6.1). For EVERY
 * execution — pass, fail, timeout, or error — the runner CHOOSES a Random_Seed,
 * pins a timezone and a Fixed_Current_Time, and records all three as an
 * {@link ExecutionContext}. The context is returned alongside the
 * {@link ActualResult} so the orchestrator can surface it on
 * `PropertyExecutionResult.executionContexts` for every property (not only on
 * FAIL). The shared Vitest classifier additionally bundles the SAME context
 * onto a FAIL Counterexample (`counterexample.executionContext`, R6.2) so a
 * Counterexample is self-describing for replay (task 11).
 *
 * HOW THE RECORDED CONTEXT MAKES THE RUN DETERMINISTIC. Recording values is not
 * enough — the recorded values must actually DRIVE the run, or replay (R6.3)
 * could not reproduce it. Two mechanisms, both injected into the no-network
 * test container:
 *
 *  1. **Seed fast-check from the recorded Random_Seed.** fast-check does not
 *     read a seed from the environment on its own; the supported mechanism is
 *     `fc.configureGlobal({ seed })` run in a Vitest setup file before any
 *     property executes (see https://fast-check.dev/docs/configuration/global-settings/).
 *     {@link buildSeedClockSetupModule} emits exactly such a setup module; it
 *     reads the seed from {@link SEED_ENV} and calls `configureGlobal`, so every
 *     `fc.assert` in the run generates the identical input sequence for a given
 *     seed. (It merges, rather than replaces, any existing global config so a
 *     property's own `numRuns` / `{ seed }` is preserved.)
 *
 *  2. **Pin `TZ` + install a Controllable_Clock pinned to the Fixed_Current_Time.**
 *     The timezone is exported for the whole phase (so date math like
 *     `new Date(y, m, 1)` is zone-stable) and the Fixed_Current_Time (threaded
 *     in via {@link FIXED_TIME_ENV}) actually DRIVES `new Date()`/`Date.now()`:
 *     the setup module installs Vitest fake timers pinned to that instant in a
 *     `beforeEach`/`afterEach` default, EXACTLY like the component-render path's
 *     {@link ../component-render.ts} `buildControllableClockSetupModule`. This
 *     is what makes a jsdom component rendered through the GENERIC
 *     `execute_properties` path see the recorded fixed date rather than the host
 *     wall clock, so its verdict is deterministic and replayable (R4.3, R6.3).
 *     The default is OPT-IN-OVERRIDABLE, not forced globally: a property that
 *     manages its own clock per fast-check iteration
 *     (`vi.useFakeTimers()`/`vi.setSystemTime()`, e.g. the walking skeleton) just
 *     re-pins the already-faked clock and takes precedence for that test, so it
 *     is never fought.
 *
 * The two helpers are pure string/record builders with no I/O so they can be
 * unit-tested directly; {@link ./test-phase.ts} writes the setup module into the
 * mount and threads {@link buildExecutionContextEnv} into the `podman run`
 * invocation.
 */
import { randomBytes } from "node:crypto";
import type { ExecutionContext } from "@spec-lantern/types";

/* -------------------------------------------------------------------------- */
/* Canonical env var names + setup-file name (the container↔context contract) */
/* -------------------------------------------------------------------------- */

/**
 * Env var carrying the recorded fast-check Random_Seed into the container. The
 * seed/clock setup module ({@link buildSeedClockSetupModule}) reads it and calls
 * `fc.configureGlobal({ seed })` so fast-check's generation is deterministic.
 */
export const SEED_ENV = "SPEC_LANTERN_RANDOM_SEED";

/**
 * Env var carrying the recorded Fixed_Current_Time (ISO instant) into the
 * container so a Controllable_Clock can pin `new Date()`/`Date.now()` to it.
 */
export const FIXED_TIME_ENV = "SPEC_LANTERN_FIXED_CURRENT_TIME";

/**
 * Env var carrying the recorded timezone into the container. Also exported as
 * `TZ` by the test script; kept as a named var so the setup module can
 * defensively re-assert it before any test module loads.
 */
export const TIMEZONE_ENV = "SPEC_LANTERN_TIMEZONE";

/**
 * File name of the seed/clock Vitest setup module written into the mount. It is
 * dotfile-prefixed and scoped to spec-lantern so it never collides with a
 * target's own files, and it lives UNDER the single mounted working directory
 * (under `/Users` on macOS) so it is visible inside the Podman VM.
 */
export const SEED_SETUP_FILE = ".spec-lantern-seed-setup.mjs";

/**
 * File name of the generated Vitest config written into the mount. It merges the
 * target's own config (so aliases / the jsdom environment survive) and only adds
 * the seed/clock setup module + the pinned `TZ` to `test.env`.
 */
export const SEED_CONFIG_FILE = ".spec-lantern-vitest.config.mjs";

/* -------------------------------------------------------------------------- */
/* Recording the Execution_Context                                            */
/* -------------------------------------------------------------------------- */

/** Default timezone pinned for an execution when the caller did not supply one. */
const DEFAULT_TIMEZONE = "UTC";

/**
 * Default Fixed_Current_Time pinned for an execution when the caller did not
 * supply one. A fixed, zone-neutral instant so time-dependent behavior is
 * reproducible by default.
 */
const DEFAULT_FIXED_CURRENT_TIME = "2025-01-01T00:00:00.000Z";

/**
 * RECORD the {@link ExecutionContext} for a single execution (R6.1).
 *
 * When the caller pinned a full context (e.g. a replay in task 11), it is used
 * verbatim so the run reproduces exactly. Otherwise a fresh context is recorded:
 * a Random_Seed CHOSEN here (a uniform 32-bit value — the range fast-check's
 * seed accepts), the default timezone, and the default Fixed_Current_Time. The
 * returned record is the single source of truth threaded both INTO the run
 * (seeding + clock) and back OUT (surfaced on the result / attached to a
 * Counterexample), so what drove the run and what is recorded can never diverge.
 */
export function recordExecutionContext(
  pinned?: ExecutionContext,
): ExecutionContext {
  if (pinned) return pinned;
  return {
    // A uniform 32-bit unsigned integer. fast-check accepts any 32-bit integer
    // seed; choosing it here (rather than letting fast-check pick an unrecorded
    // one) is what makes the seed REPRODUCIBLE — it is recorded before the run.
    randomSeed: randomBytes(4).readUInt32BE(0),
    timezone: DEFAULT_TIMEZONE,
    fixedCurrentTime: DEFAULT_FIXED_CURRENT_TIME,
  };
}

/* -------------------------------------------------------------------------- */
/* Threading the recorded context INTO the container                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the environment variables that carry the recorded {@link
 * ExecutionContext} into the no-network test container. Pure: given a context it
 * always yields the same record.
 *
 * `TZ` is set directly (the canonical variable the C library / Node read for the
 * process timezone) AND mirrored under {@link TIMEZONE_ENV}; the seed and the
 * Fixed_Current_Time travel under their dedicated vars so the setup module can
 * read them without guessing. The seed is stringified (env values are strings)
 * and re-parsed in the setup module.
 */
export function buildExecutionContextEnv(
  ctx: ExecutionContext,
): Record<string, string> {
  return {
    TZ: ctx.timezone,
    [TIMEZONE_ENV]: ctx.timezone,
    [SEED_ENV]: String(ctx.randomSeed),
    [FIXED_TIME_ENV]: ctx.fixedCurrentTime,
  };
}

/**
 * Build the source of the Vitest SETUP MODULE written into the mount and wired
 * via `setupFiles`. It runs INSIDE the container before any property executes
 * and is the mechanism that makes the recorded context actually drive the run:
 *
 *  - It reads the recorded Random_Seed from {@link SEED_ENV} and calls
 *    `fc.configureGlobal({ ...existing, seed })` so every `fc.assert` in the run
 *    generates the identical input sequence (fast-check does not read a seed
 *    from the environment itself — this is the supported seeding mechanism). The
 *    existing global config is spread first so a property's own `numRuns` (the
 *    >=100-iterations requirement) is preserved and only the seed is pinned.
 *  - It re-asserts `process.env.TZ` from {@link TIMEZONE_ENV} defensively (the
 *    script also exports it) so zone-dependent date math is stable regardless of
 *    the base image's default zone.
 *
 * It imports fast-check (and vitest) from the TARGET's own `node_modules` (the
 * install phase placed the pinned toolchain there), so no network is needed.
 *
 * THE CONTROLLABLE_CLOCK IS NOT GLOBAL `vi.setSystemTime` AT MODULE SCOPE — it
 * is a `beforeEach`/`afterEach` default pinned to the recorded Fixed_Current_Time
 * (read from {@link FIXED_TIME_ENV}), EXACTLY mirroring the component-render
 * path's `buildControllableClockSetupModule`. This is what makes a property on
 * the generic path — including a jsdom component render — observe the recorded
 * fixed date on `new Date()`/`Date.now()` rather than the host wall clock, so
 * its verdict is deterministic and replayable. Because the clock is (re)pinned
 * per test rather than forced once, a property that takes over its OWN clock
 * (`vi.useFakeTimers()`/`vi.setSystemTime()` per fast-check iteration, e.g. the
 * walking skeleton) simply re-pins the already-faked clock and wins for that
 * test — it is never fought.
 *
 * The module is tolerant: if fast-check cannot be resolved (a non-fast-check
 * property), seeding is skipped; if vitest cannot be resolved (not a Vitest
 * run) or the Fixed_Current_Time is absent/unparseable, the Controllable_Clock
 * default degrades to a no-op. Either way the run is never crashed and
 * classification is never perturbed by the setup module.
 */
export function buildSeedClockSetupModule(): string {
  return `// Generated by spec-lantern (task 10.3): seed fast-check from the recorded
// Random_Seed, pin the timezone, and install a Controllable_Clock pinned to the
// recorded Fixed_Current_Time so the execution is deterministic and replayable.
// Loaded via Vitest \`setupFiles\` before any property runs.
const seedRaw = process.env[${JSON.stringify(SEED_ENV)}];
const tz = process.env[${JSON.stringify(TIMEZONE_ENV)}];
if (tz) {
  process.env.TZ = tz;
}
const seed = seedRaw === undefined ? undefined : Number(seedRaw);
if (seed !== undefined && Number.isFinite(seed)) {
  try {
    const fc = (await import("fast-check")).default ?? (await import("fast-check"));
    const existing =
      typeof fc.readConfigureGlobal === "function"
        ? fc.readConfigureGlobal() ?? {}
        : {};
    // Spread existing first so a property's own numRuns survives; pin only seed.
    fc.configureGlobal({ ...existing, seed });
  } catch {
    // Not a fast-check property (or fast-check unresolvable) — seeding is a
    // no-op for a run that uses no randomness. Never perturb classification.
  }
}

// Controllable_Clock: pin new Date()/Date.now() to the recorded Fixed_Current_Time
// so EVERY property on the generic path — including a jsdom component render —
// sees the recorded instant, not the host wall clock. Installed as a
// beforeEach/afterEach default (mirroring the component-render path) so a
// property that manages its own clock still overrides it for its own test.
const fixedRaw = process.env[${JSON.stringify(FIXED_TIME_ENV)}];
const fixedInstant = fixedRaw ? new Date(fixedRaw) : undefined;
const hasFixedInstant =
  fixedInstant !== undefined && !Number.isNaN(fixedInstant.getTime());
if (hasFixedInstant) {
  try {
    const { beforeEach, afterEach, vi } = await import("vitest");
    // Pin the clock before each test so time-dependent logic reads ONE
    // canonical instant (R4.3/R6.3). A property re-pinning its own clock in its
    // body overrides this default.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(fixedInstant);
    });
    afterEach(() => {
      // Restore real timers so no faked clock leaks into the next test.
      vi.useRealTimers();
    });
  } catch {
    // vitest unresolvable (not a Vitest run) — the Controllable_Clock is a
    // no-op. Never perturb classification.
  }
}

// Register the @testing-library/jest-dom matchers so a component property can
// use \`toHaveAttribute\`/\`toBeInTheDocument\`/… on the generic execute path
// without rewriting the harness (jest-dom is in the pinned toolchain, but its
// matchers are inert until registered). Prefer the vitest-specific side-effect
// entry, which extends Vitest's \`expect\`; fall back to the raw matchers +
// \`expect.extend\`. Tolerant: if jest-dom cannot be resolved it is skipped so a
// non-DOM property is never perturbed and classification is unaffected.
try {
  await import("@testing-library/jest-dom/vitest");
} catch {
  try {
    const { expect } = await import("vitest");
    const matchers = await import("@testing-library/jest-dom/matchers");
    expect.extend(matchers.default ?? matchers);
  } catch {
    // jest-dom (or vitest) unresolvable — matchers stay unregistered rather
    // than crashing the run. Never perturb classification.
  }
}
`;
}

/**
 * Build the source of the generated Vitest config written into the mount. It
 * MERGES the target's own config so the target's aliases, jsdom environment, and
 * includes all survive, and only ADDS the seed/clock setup module and the pinned
 * `TZ` under `test.env`.
 *
 * WHY A STATIC IMPORT OF THE BASE CONFIG (not a runtime `await import()`). This
 * generated config is loaded by Vitest THROUGH VITE, whose loader transpiles a
 * TypeScript config on the fly. A STATIC `import` of the target's own config is
 * therefore resolved by that same loader, so a `.ts` base config (the common
 * case — e.g. a Vite/Vitest project's `vitest.config.ts`) loads correctly and
 * its aliases survive. A runtime `await import("./vitest.config.ts")` would
 * instead escape to Node's ESM loader, which cannot load raw `.ts` — it would
 * throw, the base would silently resolve to `{}`, and the target's `@` → `src`
 * alias (and jsdom env) would be dropped, surfacing as an EXECUTION_ERROR when
 * the component import fails. So the CALLER resolves the single base config file
 * that actually exists on disk and passes it as `baseConfigModule`; this builder
 * emits a static import of exactly that file (or an empty base when none exists).
 *
 * `setupModuleRel` and `baseConfigModule` are POSIX-relative paths inside the
 * mount (the caller resolves them against `CONTAINER_WORKDIR`), so this stays a
 * pure string builder and the config is relocatable with the mount.
 *
 * JSX IN A `.test.ts` PROPERTY FILE (the first packaged-Power stumble). A
 * `component_rendered` property authored by hand commonly contains JSX (it
 * renders the component with `<Foo .../>`), yet the spec layout names every
 * property file `property-{n}.{claimId}.test.ts` — a `.ts` extension, not
 * `.tsx`. esbuild (Vite's transformer) picks its loader from the file
 * extension, so a `.ts` file is parsed with the `ts` loader, which REJECTS JSX
 * ("Expected '>', got 'books'") and the whole file fails to load as an
 * EXECUTION_ERROR before any test registers. Renaming to `.tsx` is not an
 * option — the layout, the derivation loader, and the filename regex all key
 * off `.test.ts`. The fix keeps the naming and instead tells esbuild to parse
 * the STAGED PROPERTY FILES with the `tsx` loader via a tiny inline Vite plugin
 * (`load`-hook that re-runs esbuild with `loader: "tsx"` only for those files),
 * so JSX in a `.test.ts` property works without touching how the target's own
 * `.ts` sources are transformed. See {@link buildTsxLoaderPluginSource}.
 *
 * AUTO-JSDOM WHEN THE PROPERTY TOUCHES THE DOM (the second stumble). A property
 * that imports `react-dom`, `@testing-library/*`, or a `.tsx` module needs a
 * browser-like DOM, which under the generic execute path's config is NOT set
 * (`test.environment` is left to the target, usually `node`). Forgetting the
 * `// @vitest-environment jsdom` pragma then crashes with
 * "ReferenceError: document is not defined". When the caller detects those
 * imports and passes `autoJsdom: true`, this builder sets `test.environment =
 * "jsdom"` in the generated config so the property runs under jsdom
 * automatically. Vitest's per-file `// @vitest-environment` pragma OVERRIDES
 * the config environment, so an explicit pragma still wins; this only supplies
 * a DOM when the author set none. The clear DOM hint
 * ({@link ./vitest-classify.ts} `domEnvironmentHint`) still catches any case
 * the import scan cannot see.
 */
export function buildSeedClockVitestConfig(options: {
  setupModuleRel: string;
  /**
   * POSIX-relative path (inside the mount) to the ONE base Vitest/Vite config
   * the target actually has on disk, or `null` when the target has none. The
   * caller (the test-phase stager) probes the conventional filenames and passes
   * whichever exists so this builder can emit a STATIC import of it.
   */
  baseConfigModule: string | null;
  timezone: string;
  /**
   * POSIX-relative path (inside the mount) to the ONE staged property test file
   * this run executes. The emitted config installs a `tsx` esbuild loader
   * scoped to EXACTLY this file (so JSX in a `.test.ts` property parses) while
   * leaving the target's own `.ts` transforms untouched. Optional for
   * back-compat; when omitted no tsx-loader plugin is emitted.
   */
  propertyTestFileRel?: string;
  /**
   * When `true`, set `test.environment = "jsdom"` in the generated config so a
   * property that touches the DOM runs under jsdom WITHOUT an explicit
   * `// @vitest-environment jsdom` pragma. The caller sets this after scanning
   * the property file for DOM imports (`react-dom`, `@testing-library/*`, a
   * `.tsx` import). A per-file pragma still overrides this (Vitest precedence),
   * so an explicit author choice always wins.
   */
  autoJsdom?: boolean;
}): string {
  const {
    setupModuleRel,
    baseConfigModule,
    timezone,
    propertyTestFileRel,
    autoJsdom = false,
  } = options;
  // Either statically import the resolved base config (Vite transpiles TS), or
  // use an empty base when the target has no base config. A static import is
  // what lets a `.ts` base config load through Vite instead of escaping to Node.
  const baseImport =
    baseConfigModule === null
      ? "const baseRaw = {};"
      : `import baseRaw from ${JSON.stringify(baseConfigModule)};`;

  // The inline tsx-loader plugin (scoped to the one staged property file) so
  // JSX in a `.test.ts` property parses. Emitted only when the caller passed a
  // property file path; otherwise the `plugins` entry is empty.
  const tsxPluginDecl =
    propertyTestFileRel === undefined
      ? "const specLanternTsxPlugins = [];"
      : `${buildTsxLoaderPluginSource(propertyTestFileRel)}\n` +
        "const specLanternTsxPlugins = [specLanternTsxLoaderPlugin];";

  // Auto-jsdom: merge `environment: "jsdom"` only when the caller detected DOM
  // imports in the property file. A per-file `// @vitest-environment` pragma
  // still overrides this at load time, so an explicit author choice wins.
  const environmentEntry = autoJsdom
    ? `\n    // Auto-selected because the property imports react-dom /
    // @testing-library/* / a .tsx module and set no environment pragma. A
    // per-file "// @vitest-environment" pragma still overrides this.
    environment: "jsdom",`
    : "";

  return `// Generated by spec-lantern (task 10.3). Merges the target's own Vitest
// config (preserving aliases / the jsdom environment) and only adds the
// seed/clock setup module + the pinned TZ so the execution is deterministic.
// Also parses the staged property file with the tsx loader (so JSX in a
// .test.ts property works) and, when the property touches the DOM, defaults the
// environment to jsdom (a per-file pragma still overrides it).
import { mergeConfig } from "vitest/config";
import { transform as __specLanternEsbuildTransform } from "esbuild";
${baseImport}

// A Vite/Vitest config may be an object OR a (possibly async) factory function.
// Normalize to a plain config object before merging. Imported as the module's
// default export; fall back to the namespace for a rare non-default shape.
const baseExport = baseRaw && baseRaw.default !== undefined ? baseRaw.default : baseRaw;
const base =
  typeof baseExport === "function"
    ? await baseExport({ mode: "test", command: "serve" })
    : (baseExport ?? {});

${tsxPluginDecl}

export default mergeConfig(base, {
  plugins: specLanternTsxPlugins,
  test: {${environmentEntry}
    setupFiles: [${JSON.stringify(setupModuleRel)}],
    env: { TZ: ${JSON.stringify(timezone)} },
  },
});
`;
}

/**
 * Build the source of the inline Vite plugin that parses the ONE staged
 * property file with esbuild's `tsx` loader, so JSX in a `.test.ts` property
 * file loads.
 *
 * WHY A SCOPED PLUGIN RATHER THAN A GLOBAL `esbuild.loader`. Setting Vite's
 * top-level `esbuild.loader = "tsx"` with an `include` narrows esbuild to that
 * include for EVERY file, which risks dropping the target's own `.ts`/`.tsx`
 * transforms (especially when a React plugin in the base config already owns
 * `.tsx`). This plugin instead touches EXACTLY the staged property file: its
 * `load` hook reads that one file and runs esbuild's `transform` with
 * `loader: "tsx"` on it, returning transformed JS; every other module is left
 * to Vite's normal pipeline (the plugin returns `null`, meaning "not handled").
 * The plugin runs with `enforce: "pre"` so it claims the file before Vite's
 * default `.ts` loader does.
 *
 * It keys off the file's absolute path ending with the POSIX-relative property
 * path, so it matches regardless of where the mount is rooted. esbuild is
 * already a transitive dependency of Vite/Vitest (installed into the target's
 * `node_modules` by the install phase), so importing `esbuild`'s `transform`
 * needs no extra network or dependency.
 *
 * @param propertyTestFileRel POSIX-relative path (inside the mount) to the one
 *   staged property test file to parse as tsx.
 */
export function buildTsxLoaderPluginSource(propertyTestFileRel: string): string {
  // Strip any leading "./" so the suffix match is stable, then match on the
  // path ending with "/<rel>" (or exactly <rel>) regardless of the mount root.
  const normalizedRel = propertyTestFileRel.replace(/^\.?\//, "");
  return `import { readFile as __specLanternReadFile } from "node:fs/promises";
// spec-lantern tsx-loader plugin: parse the staged property file as TSX so JSX
// in a .test.ts property loads. Scoped to EXACTLY this one file; every other
// module is left to Vite's normal pipeline. Runs "pre" so it claims the file
// before the default .ts loader.
const __specLanternPropRel = ${JSON.stringify(normalizedRel)};
const __specLanternMatches = (id) => {
  const path = id.split("?")[0].split("\\\\").join("/");
  return path === __specLanternPropRel || path.endsWith("/" + __specLanternPropRel);
};
const specLanternTsxLoaderPlugin = {
  name: "spec-lantern-tsx-property-loader",
  enforce: "pre",
  async load(id) {
    if (!__specLanternMatches(id)) return null;
    const filePath = id.split("?")[0];
    const source = await __specLanternReadFile(filePath, "utf8");
    const result = await __specLanternEsbuildTransform(source, {
      loader: "tsx",
      format: "esm",
      // Use the AUTOMATIC JSX runtime so JSX compiles to react/jsx-runtime
      // calls and the property file does NOT need \`import React\` in scope
      // (the classic runtime's \`React.createElement\` would throw
      // "React is not defined"). jsxImportSource defaults to "react".
      jsx: "automatic",
      jsxImportSource: "react",
      sourcefile: filePath,
      sourcemap: true,
    });
    return { code: result.code, map: result.map };
  },
};`;
}
