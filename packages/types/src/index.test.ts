import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { SPEC_LANTERN, type Verdict } from "./index.js";

describe("@spec-lantern/types scaffolding", () => {
  it("exposes the shared feature constant", () => {
    expect(SPEC_LANTERN).toBe("spec-lantern");
  });

  // Smoke test that the fast-check + Vitest harness runs with the enforced
  // minimum-iteration global config (see vitest.setup.ts).
  it("Verdict is a closed enum of PASS | FAIL", () => {
    fc.assert(
      fc.property(fc.constantFrom<Verdict>("PASS", "FAIL"), (v) => {
        return v === "PASS" || v === "FAIL";
      }),
    );
  });
});
