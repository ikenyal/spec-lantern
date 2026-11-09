// Feature: spec-lantern — Execution_Context recording + seeding/clock pinning
// unit tests (task 10.3)
//
// EXAMPLE-BASED unit tests for the pure, I/O-free helpers in
// {@link ./execution-context.ts}. They assert the seeding + context-recording
// concern WITHOUT standing up a container:
//
//   - A context is RECORDED for an execution with a chosen Random_Seed, a
//     pinned timezone, and a Fixed_Current_Time (R6.1); a pinned context (for
//     replay, task 11) is used verbatim.
//   - The recorded context is threaded INTO the container as the exact env vars
//     the in-container setup module reads (TZ + seed + Fixed_Current_Time).
//   - The generated setup module seeds fast-check from the recorded Random_Seed
//     via `fc.configureGlobal` and re-asserts TZ (the mechanism that makes the
//     recorded values actually drive the run, so replay reproduces it).
//   - The generated Vitest config MERGES the target's own config and only adds
//     the seed/clock setup module + pinned TZ.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@spec-lantern/types";
import {
  FIXED_TIME_ENV,
  SEED_ENV,
  TIMEZONE_ENV,
  buildExecutionContextEnv,
  buildSeedClockSetupModule,
  buildSeedClockVitestConfig,
  buildTsxLoaderPluginSource,
  recordExecutionContext,
} from "./execution-context.js";

describe("recordExecutionContext — per-execution recording (R6.1)", () => {
  it("records a context with a chosen 32-bit seed, a timezone, and a Fixed_Current_Time", () => {
    const ctx = recordExecutionContext();

    // All three reproduction values are present and well-typed.
    expect(Number.isInteger(ctx.randomSeed)).toBe(true);
    expect(ctx.randomSeed).toBeGreaterThanOrEqual(0);
    expect(ctx.randomSeed).toBeLessThanOrEqual(0xff_ff_ff_ff);
    expect(typeof ctx.timezone).toBe("string");
    expect(ctx.timezone.length).toBeGreaterThan(0);
    // A valid ISO instant for the Controllable_Clock.
    expect(Number.isNaN(Date.parse(ctx.fixedCurrentTime))).toBe(false);
  });

  it("uses a caller-pinned context verbatim (replay path, R6.3)", () => {
    const pinned: ExecutionContext = {
      randomSeed: 123456,
      timezone: "America/New_York",
      fixedCurrentTime: "1999-08-15T09:30:00.000Z",
    };
    expect(recordExecutionContext(pinned)).toEqual(pinned);
  });

  it("chooses a fresh seed on each unpinned recording (not a constant)", () => {
    // Record several contexts; the seeds should not all be identical. (A chosen
    // seed is what makes the run reproducible — it is recorded, not left to an
    // unrecorded internal default.)
    const seeds = new Set(
      Array.from({ length: 16 }, () => recordExecutionContext().randomSeed),
    );
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe("buildExecutionContextEnv — threading the context into the container", () => {
  it("carries TZ + seed + Fixed_Current_Time as the env the setup module reads", () => {
    const ctx: ExecutionContext = {
      randomSeed: 42,
      timezone: "UTC",
      fixedCurrentTime: "2025-01-01T00:00:00.000Z",
    };
    const env = buildExecutionContextEnv(ctx);

    // TZ is the canonical process-timezone variable, pinned to the recorded zone.
    expect(env.TZ).toBe("UTC");
    expect(env[TIMEZONE_ENV]).toBe("UTC");
    // The seed travels as a string (env values are strings) and round-trips.
    expect(env[SEED_ENV]).toBe("42");
    expect(Number(env[SEED_ENV])).toBe(ctx.randomSeed);
    // The Fixed_Current_Time is made available for a Controllable_Clock.
    expect(env[FIXED_TIME_ENV]).toBe("2025-01-01T00:00:00.000Z");
  });

  it("is pure — same context yields the same env", () => {
    const ctx: ExecutionContext = {
      randomSeed: 7,
      timezone: "UTC",
      fixedCurrentTime: "2025-01-01T00:00:00.000Z",
    };
    expect(buildExecutionContextEnv(ctx)).toEqual(buildExecutionContextEnv(ctx));
  });
});

describe("buildSeedClockSetupModule — seeds fast-check + pins TZ in-container", () => {
  const module = buildSeedClockSetupModule();

  it("seeds fast-check from the recorded Random_Seed via configureGlobal", () => {
    // Reads the seed from the canonical env var and pins it on fast-check's
    // global config (the supported seeding mechanism).
    expect(module).toContain(`process.env[${JSON.stringify(SEED_ENV)}]`);
    expect(module).toContain("configureGlobal");
    expect(module).toContain("fast-check");
  });

  it("re-asserts the pinned timezone from the recorded context", () => {
    expect(module).toContain(`process.env[${JSON.stringify(TIMEZONE_ENV)}]`);
    expect(module).toContain("process.env.TZ");
  });

  it("preserves a property's own global config (spreads existing before pinning seed)", () => {
    // `{ ...existing, seed }` — the property's numRuns (the >=100 requirement)
    // must survive; only the seed is pinned.
    expect(module).toContain("...existing");
  });

  it("is tolerant when fast-check is absent (never crashes a non-fast-check run)", () => {
    // Wrapped in try/catch so a non-fast-check property is not perturbed.
    expect(module).toContain("try");
    expect(module).toContain("catch");
  });

  // GAP 1 (runner-fixedclock-helpers): a property on the GENERIC execute path —
  // including a jsdom component render — must observe the recorded
  // Fixed_Current_Time on new Date()/Date.now(), NOT the host wall clock, or the
  // monthly-order verdict is nondeterministic and needs re-locks. The generic
  // setup module therefore installs a Controllable_Clock pinned to the recorded
  // instant (read from FIXED_TIME_ENV), mirroring the component-render path.
  describe("installs a Controllable_Clock pinned to the recorded Fixed_Current_Time (GAP 1)", () => {
    it("reads the Fixed_Current_Time from the recorded env var (not the host clock)", () => {
      // The clock is driven by the RECORDED instant threaded in as FIXED_TIME_ENV,
      // so a replay reproduces the exact same date — never the real wall clock.
      expect(module).toContain(`process.env[${JSON.stringify(FIXED_TIME_ENV)}]`);
    });

    it("pins Vitest fake timers to that recorded instant so new Date()/Date.now() are fixed", () => {
      // Installing fake timers + setSystemTime(fixedInstant) is what makes
      // new Date()/Date.now() return the recorded date instead of the host clock.
      expect(module).toContain("useFakeTimers");
      expect(module).toContain("setSystemTime");
      expect(module).toContain("fixedInstant");
    });

    it("pins the clock per-test as an overridable default (beforeEach/afterEach), not a forced global", () => {
      // beforeEach/afterEach gives a sane default a property can still override
      // with its own vi.useFakeTimers()/vi.setSystemTime() per fast-check
      // iteration (the walking-skeleton path), exactly like the component-render
      // Controllable_Clock. afterEach restores real timers so nothing leaks.
      expect(module).toContain("beforeEach");
      expect(module).toContain("afterEach");
      expect(module).toContain("useRealTimers");
    });

    it("only pins the clock when a valid Fixed_Current_Time is present (degrades to a no-op otherwise)", () => {
      // An absent/unparseable instant must not pin a clock; a run with no fixed
      // time is unaffected and classification is never perturbed.
      expect(module).toContain("hasFixedInstant");
      expect(module).toContain("Number.isNaN");
    });

    it("imports vitest tolerantly so a non-Vitest run is never crashed by the clock default", () => {
      // The clock install is wrapped so vitest being unresolvable degrades to a
      // no-op rather than throwing (same tolerance as the fast-check seeding).
      expect(module).toContain('await import("vitest")');
    });
  });
});

// GAP 1 BEHAVIORAL TEST (runner-fixedclock-helpers): the string-builder checks
// above prove the mechanism is EMITTED; this one proves it WORKS. It writes the
// generated setup module to a temp .mjs with FIXED_TIME_ENV set to a recorded
// instant that is NOT the host wall clock, imports it so its beforeEach/afterEach
// register for this suite, and then asserts a property observing
// new Date()/Date.now() sees the RECORDED instant. It FAILS if the property ever
// sees a date other than the recorded one (e.g. the real Nov-2026 wall clock).
describe("buildSeedClockSetupModule — the recorded fixed clock actually drives Date (GAP 1)", async () => {
  // A recorded instant deliberately far from any plausible host wall clock, so
  // "sees the recorded date" and "sees the host clock" can never coincide.
  const RECORDED_FIXED_TIME = "2025-01-01T00:00:00.000Z";
  const tmpDir = mkdtempSync(join(tmpdir(), "spec-lantern-seed-clock-"));
  const prevFixedTime = process.env[FIXED_TIME_ENV];

  // The generated module reads FIXED_TIME_ENV at import time — set it first.
  process.env[FIXED_TIME_ENV] = RECORDED_FIXED_TIME;

  const modulePath = join(tmpDir, "seed-clock-setup.mjs");
  writeFileSync(modulePath, buildSeedClockSetupModule());

  // Import the generated module here (top of the suite body) so the
  // beforeEach/afterEach it registers via vitest apply to the it()s below.
  await import(pathToFileURL(modulePath).href);

  afterAll(() => {
    if (prevFixedTime === undefined) {
      delete process.env[FIXED_TIME_ENV];
    } else {
      process.env[FIXED_TIME_ENV] = prevFixedTime;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("makes new Date() return the recorded Fixed_Current_Time, not the host wall clock", () => {
    // Under the pinned clock, new Date() is the recorded instant exactly.
    expect(new Date().toISOString()).toBe(RECORDED_FIXED_TIME);
  });

  it("makes Date.now() return the recorded Fixed_Current_Time epoch, not the host clock", () => {
    expect(Date.now()).toBe(Date.parse(RECORDED_FIXED_TIME));
  });
});

describe("buildSeedClockVitestConfig — merges the target's own config", () => {
  it("statically imports a resolved base config and adds the setup module + pinned TZ", () => {
    const cfg = buildSeedClockVitestConfig({
      setupModuleRel: "./.spec-lantern-seed-setup.mjs",
      // The ONE base config the target actually has, resolved by the caller.
      baseConfigModule: "./vitest.config.ts",
      timezone: "UTC",
    });

    // Uses mergeConfig so the target's aliases / jsdom env survive.
    expect(cfg).toContain("mergeConfig");
    // STATICALLY imports the resolved base config (so a .ts base loads through
    // Vite instead of escaping to Node, which cannot import raw .ts).
    expect(cfg).toContain(`import baseRaw from "./vitest.config.ts"`);
    // It must NOT use a runtime dynamic import of the base config (the defect
    // that silently dropped the target's aliases).
    expect(cfg).not.toContain(`await import("./vitest.config.ts")`);
    // Adds the seed/clock setup module to setupFiles.
    expect(cfg).toContain("setupFiles");
    expect(cfg).toContain("./.spec-lantern-seed-setup.mjs");
    // Pins TZ under test.env.
    expect(cfg).toContain('TZ: "UTC"');
    // Normalizes a config that may be a factory function.
    expect(cfg).toContain("typeof baseExport === \"function\"");
  });

  it("uses an empty base (no import) when the target has no config", () => {
    const cfg = buildSeedClockVitestConfig({
      setupModuleRel: "./.spec-lantern-seed-setup.mjs",
      baseConfigModule: null,
      timezone: "UTC",
    });

    // No base config to import — an empty base object, still a valid run.
    expect(cfg).toContain("const baseRaw = {}");
    expect(cfg).not.toContain("import baseRaw from");
    // Still wires the setup module + pinned TZ.
    expect(cfg).toContain("./.spec-lantern-seed-setup.mjs");
    expect(cfg).toContain('TZ: "UTC"');
  });

  it("emits a tsx-loader plugin scoped to the staged property file (JSX in a .test.ts)", () => {
    // Stumble #1: a `.test.ts` property containing JSX failed to load because
    // esbuild parsed it with the `ts` loader. The generated config must install
    // a plugin that parses EXACTLY the staged property file with the tsx loader.
    const cfg = buildSeedClockVitestConfig({
      setupModuleRel: "./.spec-lantern-seed-setup.mjs",
      baseConfigModule: null,
      timezone: "UTC",
      propertyTestFileRel:
        ".spec-lantern/pc/properties/property-1.claim-x.test.ts",
    });

    // Imports esbuild's transform and wires a plugin keyed to the property file.
    expect(cfg).toContain('import { transform as __specLanternEsbuildTransform } from "esbuild"');
    expect(cfg).toContain("spec-lantern-tsx-property-loader");
    expect(cfg).toContain('loader: "tsx"');
    expect(cfg).toContain(
      ".spec-lantern/pc/properties/property-1.claim-x.test.ts",
    );
    // The plugin is registered in the merged config's `plugins`.
    expect(cfg).toContain("plugins: specLanternTsxPlugins");
    expect(cfg).toContain(
      "const specLanternTsxPlugins = [specLanternTsxLoaderPlugin]",
    );
  });

  it("emits no tsx plugin and does not set jsdom when neither option is given (back-compat)", () => {
    const cfg = buildSeedClockVitestConfig({
      setupModuleRel: "./.spec-lantern-seed-setup.mjs",
      baseConfigModule: null,
      timezone: "UTC",
    });

    // Empty plugins array, no esbuild transform import, no forced environment.
    expect(cfg).toContain("const specLanternTsxPlugins = []");
    expect(cfg).not.toContain("spec-lantern-tsx-property-loader");
    expect(cfg).not.toContain('environment: "jsdom"');
  });

  it("defaults environment to jsdom only when autoJsdom is set", () => {
    // Stumble #2: a DOM-touching property with no pragma crashed under node.
    const withJsdom = buildSeedClockVitestConfig({
      setupModuleRel: "./.spec-lantern-seed-setup.mjs",
      baseConfigModule: null,
      timezone: "UTC",
      propertyTestFileRel: "properties/property-1.claim-x.test.ts",
      autoJsdom: true,
    });
    expect(withJsdom).toContain('environment: "jsdom"');

    const withoutJsdom = buildSeedClockVitestConfig({
      setupModuleRel: "./.spec-lantern-seed-setup.mjs",
      baseConfigModule: null,
      timezone: "UTC",
      propertyTestFileRel: "properties/property-1.claim-x.test.ts",
      autoJsdom: false,
    });
    expect(withoutJsdom).not.toContain('environment: "jsdom"');
  });
});

describe("buildTsxLoaderPluginSource — scoped tsx parsing of the property file", () => {
  it("matches the property file by path suffix, strips a leading ./, and uses the tsx loader", () => {
    const src = buildTsxLoaderPluginSource(
      "./.spec-lantern/pc/properties/property-1.claim-x.test.ts",
    );

    // The leading "./" is stripped so the suffix match is stable.
    expect(src).toContain(
      '".spec-lantern/pc/properties/property-1.claim-x.test.ts"',
    );
    // Matches either the exact relative path or any absolute path ending in it.
    expect(src).toContain("path === __specLanternPropRel");
    expect(src).toContain('path.endsWith("/" + __specLanternPropRel)');
    // Runs "pre" so it claims the file before the default .ts loader, and parses
    // it as tsx via esbuild's transform.
    expect(src).toContain('enforce: "pre"');
    expect(src).toContain('loader: "tsx"');
    // Uses the AUTOMATIC JSX runtime so the property file needs no `import React`
    // (the classic runtime's React.createElement would throw "React is not defined").
    expect(src).toContain('jsx: "automatic"');
    expect(src).toContain('jsxImportSource: "react"');
    // Reads the file itself in its load hook (does not rely on Vite's ts loader).
    expect(src).toContain("__specLanternReadFile");
  });
});
