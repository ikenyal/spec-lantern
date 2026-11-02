// Feature: spec-lantern — jsdom component-render harness unit tests (task 12.1)
//
// EXAMPLE-BASED unit tests for the pure, I/O-free builders + the render-decision
// logic in {@link ./component-render.ts}. They assert the component-render
// concern WITHOUT standing up a container:
//
//   - planComponentRender renders ONLY props-driven component_rendered
//     properties; a function property or a component_rendered property with no
//     embeddedComponentLogic (how an internally-fetching Claim is recorded
//     unverifiable, R3.6/R4.1) renders NOTHING.
//   - The generated Vitest config supplies the `@` -> src alias + the jsdom
//     environment, wires both render setup modules, includes the property
//     file(s), and aliases the backend client to the inert stub.
//   - The Controllable_Clock setup module pins Vitest fake timers to the
//     recorded Fixed_Current_Time and re-asserts the pinned TZ (R4.3), and is
//     tolerant (never crashes a non-Vitest run / a missing instant).
//   - The DOM-interaction shim bridges waitFor to Vitest fake timers and makes
//     fireEvent.click emit the pointerdown/mousedown Radix activates on.
//   - The backend stub throws loudly if an internal client is actually called.

import { describe, expect, it } from "vitest";
import type { CorrectnessProperty } from "@spec-lantern/types";
import {
  COMPONENT_RENDER_BACKEND_STUB_FILE,
  COMPONENT_RENDER_SETUP_FILE,
  COMPONENT_RENDER_SHIM_FILE,
  buildBackendClientStubModule,
  buildComponentRenderVitestConfig,
  buildControllableClockSetupModule,
  buildDomInteractionShimModule,
  planComponentRender,
} from "./component-render.js";
import { FIXED_TIME_ENV, TIMEZONE_ENV } from "./execution-context.js";

/* -------------------------------------------------------------------------- */
/* planComponentRender — props-driven renders; else render NOTHING (R4.1/R3.6)*/
/* -------------------------------------------------------------------------- */

function makeProperty(
  overrides: Partial<CorrectnessProperty> = {},
): CorrectnessProperty {
  return {
    id: "property-1.claim-x",
    claimId: "claim-x",
    title: "t",
    statement: "for all props, the component renders",
    kind: "component_rendered",
    validatesRequirements: ["4.2"],
    ...overrides,
  };
}

describe("planComponentRender — only props-driven component_rendered renders", () => {
  it("renders a props-driven component_rendered property with its componentPath + mockedData", () => {
    const mockedData = { books: [{ id: "a" }] };
    const plan = planComponentRender(
      makeProperty({
        embeddedComponentLogic: {
          componentPath: "@/components/statistics/PeriodProgressSummary",
          mockedData,
        },
      }),
    );
    expect(plan.render).toBe(true);
    if (plan.render) {
      expect(plan.componentPath).toBe(
        "@/components/statistics/PeriodProgressSummary",
      );
      expect(plan.mockedData).toEqual(mockedData);
    }
  });

  it("renders NOTHING for a kind: function property", () => {
    const plan = planComponentRender(
      makeProperty({ kind: "function", embeddedComponentLogic: undefined }),
    );
    expect(plan.render).toBe(false);
    if (!plan.render) expect(plan.reason).toContain("function");
  });

  it("renders NOTHING for a component_rendered property with no embeddedComponentLogic (internally-fetching ⇒ unverifiable, R3.6/R4.1)", () => {
    const plan = planComponentRender(
      makeProperty({ embeddedComponentLogic: undefined }),
    );
    expect(plan.render).toBe(false);
    if (!plan.render) {
      expect(plan.reason).toContain("unverifiable");
    }
  });

  it("renders NOTHING when embeddedComponentLogic has an empty componentPath", () => {
    const plan = planComponentRender(
      makeProperty({
        embeddedComponentLogic: { componentPath: "", mockedData: {} },
      }),
    );
    expect(plan.render).toBe(false);
  });

  it("is pure — same property yields the same plan", () => {
    const property = makeProperty({
      embeddedComponentLogic: { componentPath: "@/C", mockedData: { n: 1 } },
    });
    expect(planComponentRender(property)).toEqual(
      planComponentRender(property),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* buildComponentRenderVitestConfig — jsdom + @ alias + both setup modules    */
/* -------------------------------------------------------------------------- */

describe("buildComponentRenderVitestConfig — jsdom render config", () => {
  const cfg = buildComponentRenderVitestConfig({
    includeGlob: "src/__spec_lantern__/**/*.test.ts",
  });

  it("sets the jsdom environment so @testing-library/react can render + query", () => {
    expect(cfg).toContain('environment: "jsdom"');
  });

  it("supplies the project's @ -> src alias", () => {
    expect(cfg).toContain("/^@\\//");
    expect(cfg).toContain('resolve(rootDir, "./src")');
  });

  it("wires BOTH render setup modules (DOM shim first, then the Controllable_Clock)", () => {
    const shimIdx = cfg.indexOf(COMPONENT_RENDER_SHIM_FILE);
    const setupIdx = cfg.indexOf(COMPONENT_RENDER_SETUP_FILE);
    expect(shimIdx).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    // Shim listed before the clock so its fake-timer bridge is in place first.
    expect(shimIdx).toBeLessThan(setupIdx);
  });

  it("includes exactly the property glob it was given", () => {
    expect(cfg).toContain('include: ["src/__spec_lantern__/**/*.test.ts"]');
  });

  it("aliases the default backend client (Supabase) to the inert stub, before the general @ rule", () => {
    const backendIdx = cfg.indexOf(COMPONENT_RENDER_BACKEND_STUB_FILE);
    const generalAliasIdx = cfg.indexOf("/^@\\//");
    expect(backendIdx).toBeGreaterThanOrEqual(0);
    // The specific backend rule must precede the general "@/" rule so it wins.
    expect(cfg.indexOf("@/integrations/supabase/client")).toBeLessThan(
      generalAliasIdx,
    );
  });

  it("honors a custom src dir and custom backend-client patterns", () => {
    const custom = buildComponentRenderVitestConfig({
      includeGlob: "app/**/*.test.ts",
      srcDirRel: "./app",
      backendClientSpecifierPatterns: [String.raw`^@/lib/api$`],
    });
    expect(custom).toContain('resolve(rootDir, "./app")');
    expect(custom).toContain("@/lib/api");
    expect(custom).not.toContain("supabase");
  });
});

/* -------------------------------------------------------------------------- */
/* buildControllableClockSetupModule — pins fake timers to Fixed_Current_Time */
/* -------------------------------------------------------------------------- */

describe("buildControllableClockSetupModule — Controllable_Clock (R4.3)", () => {
  const module = buildControllableClockSetupModule();

  it("reads the recorded Fixed_Current_Time and pins Vitest fake timers to it", () => {
    expect(module).toContain(`process.env[${JSON.stringify(FIXED_TIME_ENV)}]`);
    expect(module).toContain("useFakeTimers");
    expect(module).toContain("setSystemTime");
  });

  it("re-asserts the pinned timezone from the recorded context", () => {
    expect(module).toContain(`process.env[${JSON.stringify(TIMEZONE_ENV)}]`);
    expect(module).toContain("process.env.TZ");
  });

  it("restores real timers after each test so no faked clock leaks", () => {
    expect(module).toContain("useRealTimers");
    expect(module).toContain("afterEach");
  });

  it("is tolerant when vitest is absent or the instant is missing (never crashes)", () => {
    expect(module).toContain("try");
    expect(module).toContain("catch");
    expect(module).toContain("hasFixedInstant");
  });
});

/* -------------------------------------------------------------------------- */
/* buildDomInteractionShimModule — waitFor bridge + Radix click shim          */
/* -------------------------------------------------------------------------- */

describe("buildDomInteractionShimModule — reusable render plumbing", () => {
  const module = buildDomInteractionShimModule();

  it("bridges waitFor to Vitest fake timers via a jest.advanceTimersByTime shim", () => {
    expect(module).toContain("advanceTimersByTime");
    expect(module).toContain("globalThis.jest");
  });

  it("makes fireEvent.click emit the pointerdown/mousedown Radix activates on", () => {
    expect(module).toContain("fireEvent.click");
    expect(module).toContain("pointerDown");
    expect(module).toContain("mouseDown");
  });

  it("is tolerant when @testing-library/react is unresolvable", () => {
    expect(module).toContain("try");
    expect(module).toContain("catch");
  });
});

/* -------------------------------------------------------------------------- */
/* buildBackendClientStubModule — inert stub that throws if actually called   */
/* -------------------------------------------------------------------------- */

describe("buildBackendClientStubModule — inert backend stub", () => {
  const module = buildBackendClientStubModule();

  it("exports a client/supabase/default proxy that throws loudly if called", () => {
    expect(module).toContain("export const client");
    expect(module).toContain("export const supabase");
    expect(module).toContain("export default");
    expect(module).toContain("new Proxy");
    expect(module).toContain("throw new Error");
  });

  it("names the props-driven requirement + unverifiable rule in its throw", () => {
    expect(module).toContain("props-driven");
    expect(module).toContain("unverifiable");
  });
});
