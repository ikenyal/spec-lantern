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
 *  2. **Pin `TZ` + expose the Fixed_Current_Time.** The timezone is exported for
 *     the whole phase (so date math like `new Date(y, m, 1)` is zone-stable) and
 *     the Fixed_Current_Time is placed in {@link FIXED_TIME_ENV} and
 *     `process.env` so a Controllable_Clock (fake timers pinned to that instant;
 *     the component-render path is task 12) reads one canonical instant. This
 *     module does NOT force fake timers globally — a property that manages its
 *     own `vi.useFakeTimers()`/`vi.setSystemTime()` (e.g. the walking skeleton)
 *     must not be fought — it only makes the recorded instant available and sets
 *     a stable default.
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
 * It imports fast-check from the TARGET's own `node_modules` (the install phase
 * placed the pinned toolchain there), so no network is needed. It does NOT force
 * fake timers globally: pinning the clock for a specific render is the
 * component-render path's job (task 12), and forcing timers here would fight a
 * property that manages its own clock (the walking skeleton calls
 * `vi.useFakeTimers()` per iteration). The Fixed_Current_Time is made available
 * via {@link FIXED_TIME_ENV} for code that opts into a Controllable_Clock.
 *
 * The module is tolerant: if fast-check cannot be resolved (a non-fast-check
 * property), seeding is skipped rather than crashing the run — seeding a run
 * that uses no randomness is a no-op either way, and classification must not be
 * perturbed by the setup module.
 */
export function buildSeedClockSetupModule(): string {
  return `// Generated by spec-lantern (task 10.3): seed fast-check from the recorded
// Random_Seed and pin the timezone so the execution is deterministic and
// replayable. Loaded via Vitest \`setupFiles\` before any property runs.
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
}): string {
  const { setupModuleRel, baseConfigModule, timezone } = options;
  // Either statically import the resolved base config (Vite transpiles TS), or
  // use an empty base when the target has no config. A static import is what
  // lets a `.ts` base config load through Vite instead of escaping to Node.
  const baseImport =
    baseConfigModule === null
      ? "const baseRaw = {};"
      : `import baseRaw from ${JSON.stringify(baseConfigModule)};`;
  return `// Generated by spec-lantern (task 10.3). Merges the target's own Vitest
// config (preserving aliases / the jsdom environment) and only adds the
// seed/clock setup module + the pinned TZ so the execution is deterministic.
import { mergeConfig } from "vitest/config";
${baseImport}

// A Vite/Vitest config may be an object OR a (possibly async) factory function.
// Normalize to a plain config object before merging. Imported as the module's
// default export; fall back to the namespace for a rare non-default shape.
const baseExport = baseRaw && baseRaw.default !== undefined ? baseRaw.default : baseRaw;
const base =
  typeof baseExport === "function"
    ? await baseExport({ mode: "test", command: "serve" })
    : (baseExport ?? {});

export default mergeConfig(base, {
  test: {
    setupFiles: [${JSON.stringify(setupModuleRel)}],
    env: { TZ: ${JSON.stringify(timezone)} },
  },
});
`;
}
