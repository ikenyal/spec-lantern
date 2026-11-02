// Feature: spec-lantern — no-network test-phase unit tests (task 9.2)
//
// These are EXAMPLE-BASED unit tests for the no-network Test_Execution_Phase
// and the two-phase composition ({@link ./test-phase.ts}). They assert the
// invariants that hold WITHOUT a live Podman engine, so the regular host
// `npm test` stays fast and offline:
//
//   - No host fallback (R5.8 / R12.5). When Podman is unavailable, both the
//     standalone test phase (`runTestPhase`) and the two-phase composition
//     (`runTwoPhase`) surface a closed non-VERDICT ActualResult and NEVER a
//     VERDICT — there is no code path from "container could not be created" to a
//     host-executed PASS/FAIL. This is asserted only when Podman is actually
//     unreachable within a bounded probe (the default host CI/dev environment);
//     when a reachable engine is present the heavy, container-backed path
//     belongs to the task 10.5 integration smoke test, so these unit tests skip
//     rather than standing up real containers.
//
//   - Phase ordering (R5.4). `runTwoPhase` runs the Dependency_Install_Phase
//     FIRST and only starts the no-network test phase on install success. When
//     the install phase cannot complete (no reachable Podman ⇒ the topology
//     cannot be created), `runTwoPhase` surfaces the install phase's closed
//     non-VERDICT result UNCHANGED and the test phase never runs — the test
//     container can never be observed starting before the install completes.
//     This is proved deterministically with an INJECTED install-phase stub (so
//     it holds regardless of whether Podman is present): a stub that reports
//     install failure must short-circuit before any test-phase work, and a stub
//     that reports success must be invoked strictly before the test phase.
//
//   - The closed ActualResult discipline. A non-verdict outcome is one of the
//     closed non-VERDICT shapes from `@spec-lantern/types`; the test phase never
//     invents a bespoke result shape and never encodes a failure as PASS/FAIL.
//
// The full container-backed slice (install through the proxy, then Vitest with
// `--network none` against the installed deps) is the required integration
// smoke test in task 10.5; it is intentionally not here.

import { describe, expect, it, vi } from "vitest";
import { runTestPhase, runTwoPhase } from "./test-phase.js";
import * as installPhase from "./install-phase.js";

const PROPERTY_ID = "property-1.claim-monthly-order";

/**
 * Probe whether Podman is reachable within a bounded window, matching the
 * runner's own lightweight `podman info` check. Returns false when the binary
 * is absent, errors, or does not respond in time (installed-but-not-started).
 * Used to decide whether the no-host-fallback assertions below can run offline
 * or must defer to the task 10.5 container-backed smoke test.
 */
async function podmanReachable(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolvePromise) => {
    const child = spawn("podman", ["info", "--format", "{{.Version.Version}}"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise(false);
    }, 15_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0);
    });
  });
}

// A reachable Podman means the heavy container path would actually run; that is
// the task 10.5 integration smoke test's job, so we only assert the offline
// no-fallback path here when Podman is NOT reachable (absent or hung). The 25s
// ceiling clears the runner's internal 15s unavailability probe.
const PODMAN_REACHABLE = await podmanReachable();

describe("test phase — no-host-fallback when Podman is unavailable (task 9.2)", () => {
  it.skipIf(PODMAN_REACHABLE)(
    "runTestPhase surfaces RUNNER_UNAVAILABLE (never a VERDICT) when Podman cannot create the no-network container",
    async () => {
      const result = await runTestPhase({
        propertyId: PROPERTY_ID,
        targetRepoPath: process.cwd(),
        // Never actually runs — the Podman unavailability guard returns first.
        propertyTestFile: "does-not-matter.test.ts",
        timeoutSeconds: 5,
      });

      // Tied to the property, and specifically NOT a verdict (a FAIL/PASS would
      // imply a host run).
      expect(result.propertyId).toBe(PROPERTY_ID);
      expect(result.outcome).not.toBe("VERDICT");
      // With no reachable engine the guard reports RUNNER_UNAVAILABLE.
      expect(result.outcome).toBe("RUNNER_UNAVAILABLE");
    },
    25_000,
  );

  it.skipIf(PODMAN_REACHABLE)(
    "runTwoPhase surfaces a closed non-VERDICT outcome (never a VERDICT) when Podman cannot stand up either phase",
    async () => {
      const result = await runTwoPhase({
        propertyId: PROPERTY_ID,
        targetRepoPath: process.cwd(),
        propertyTestFile: "does-not-matter.test.ts",
        timeoutSeconds: 5,
        install: { timeoutSeconds: 5 },
      });

      expect(result.propertyId).toBe(PROPERTY_ID);
      // No PASS/FAIL — the install phase's topology creation fails first with no
      // reachable Podman, and that closed result is surfaced unchanged.
      expect(result.outcome).not.toBe("VERDICT");
      expect([
        "RUNNER_UNAVAILABLE",
        "EXECUTION_ERROR",
        "TIMEOUT",
        "SAFETY_VIOLATION",
      ]).toContain(result.outcome);
    },
    25_000,
  );
});

describe("two-phase ordering — install precedes the test phase (task 9.2, R5.4)", () => {
  // These are deterministic regardless of Podman: they inject a stub install
  // phase so we can assert the ordering/short-circuit contract without a live
  // engine. They never stand up a real container.

  it("does NOT run the no-network test phase when the install phase fails", async () => {
    // Stub the install phase to report a closed non-VERDICT failure.
    const installFailure = {
      propertyId: PROPERTY_ID,
      outcome: "RUNNER_UNAVAILABLE",
      reason: "stubbed: install topology could not be created",
    } as const;
    const installSpy = vi
      .spyOn(installPhase, "runInstallPhase")
      .mockResolvedValue({ ok: false, result: installFailure });

    try {
      const result = await runTwoPhase({
        propertyId: PROPERTY_ID,
        // A path that would make the test phase throw if it were ever reached,
        // so reaching the test phase cannot be mistaken for a pass.
        targetRepoPath: "/nonexistent/spec-lantern/should-never-be-mounted",
        propertyTestFile: "irrelevant.test.ts",
      });

      // The install phase ran…
      expect(installSpy).toHaveBeenCalledTimes(1);
      // …and its exact closed non-VERDICT result was surfaced UNCHANGED, which
      // is only possible if the test phase was short-circuited (never run).
      expect(result).toEqual(installFailure);
      expect(result.outcome).toBe("RUNNER_UNAVAILABLE");
    } finally {
      installSpy.mockRestore();
    }
  });

  // Gated to the offline case: `runTwoPhase` calls the REAL `runTestPhase` after
  // a successful install (an internal same-module call a spy cannot intercept),
  // so with a reachable Podman this would stand up a real container — task
  // 10.5's job. When Podman is NOT reachable the test phase's own guard returns
  // RUNNER_UNAVAILABLE without any container, which is exactly the observable we
  // use to prove control reached the test phase only AFTER a successful install.
  it.skipIf(PODMAN_REACHABLE)(
    "runs the install phase strictly BEFORE the no-network test phase on success",
    async () => {
    // Record call order: the install stub must be invoked before the test phase
    // begins its own Podman work. We prove ordering by (a) stubbing install to
    // succeed and (b) running under no reachable Podman so the test phase's own
    // guard returns RUNNER_UNAVAILABLE — the only way to observe that outcome is
    // for control to have reached the test phase AFTER a successful install.
    const order: string[] = [];
    const installSpy = vi
      .spyOn(installPhase, "runInstallPhase")
      .mockImplementation(async () => {
        order.push("install");
        return { ok: true };
      });

    try {
      const result = await runTwoPhase({
        propertyId: PROPERTY_ID,
        targetRepoPath: process.cwd(),
        propertyTestFile: "irrelevant.test.ts",
        timeoutSeconds: 5,
      });

      // Install was invoked exactly once, first.
      expect(installSpy).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["install"]);

      // The test phase then ran AFTER the successful install: with no reachable
      // Podman its own unavailability guard returns RUNNER_UNAVAILABLE (no
      // container is ever created) — observing that outcome proves control
      // reached the test phase only after the install succeeded.
      expect(result.propertyId).toBe(PROPERTY_ID);
      expect(result.outcome).toBe("RUNNER_UNAVAILABLE");
    } finally {
      installSpy.mockRestore();
    }
  },
    25_000,
  );
});
