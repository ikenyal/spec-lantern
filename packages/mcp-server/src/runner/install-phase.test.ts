// Feature: spec-lantern — install-phase network-topology unit tests (task 9.1)
//
// These are EXAMPLE-BASED unit tests for the install-phase topology lifecycle
// ({@link ./install-phase.ts}). They assert the invariants that hold WITHOUT a
// live Podman engine, so the regular host `npm test` stays fast and offline:
//
//   - No host fallback (R5.8 / R12.5). When Podman is unavailable, the
//     orchestration entry point `runInstallPhase` surfaces a closed non-VERDICT
//     ActualResult and NEVER a VERDICT — there is no code path from "topology
//     could not be created" to a host-executed result. This is asserted only
//     when Podman is actually unreachable within a bounded probe (the default
//     host CI/dev environment); when a reachable engine is present the heavy,
//     container-backed path belongs to the task 10.5 integration smoke test, so
//     this unit test skips rather than standing up real containers. The probe
//     itself is given headroom above the runner's internal 15s unavailability
//     timeout so a HUNG (installed-but-not-started) Podman still resolves to
//     RUNNER_UNAVAILABLE rather than tripping vitest's default per-test timeout.
//
//   - Teardown is robust and idempotent (R5.4 / R12.3). `teardownInstallTopology`
//     resolves without throwing even for a topology that was never created (a
//     missing network/container is not an error), so the two-phase split's
//     "tear the install topology down before the test phase" guarantee holds
//     even on partial failure.
//
//   - The closed ActualResult discipline. A non-ok install-phase outcome is one
//     of the closed non-VERDICT shapes from `@spec-lantern/types`; the install
//     phase never invents a bespoke result shape and never encodes a failure as
//     PASS/FAIL.
//
// The full container-backed slice (internal-only network + Verdaccio proxy +
// install container reaching the proxy but no direct outbound route) is the
// required integration smoke test in task 10.5; it is intentionally not here.

import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  createInstallTopology,
  isProvablyOrphaned,
  reapLeftoverInstallResources,
  runInstallPhase,
  teardownInstallTopology,
} from "./install-phase.js";

const PROPERTY_ID = "property-1.claim-monthly-order";

/**
 * Probe whether Podman is reachable within a bounded window, matching the
 * runner's own lightweight `podman info` check. Returns false when the binary
 * is absent, errors, or does not respond in time (installed-but-not-started).
 * Used to decide whether the no-host-fallback assertion below can run offline
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

describe("install-phase topology — no-host-fallback (task 9.1)", () => {
  it.skipIf(PODMAN_REACHABLE)(
    "surfaces a closed non-VERDICT outcome (never a VERDICT) when Podman cannot stand up the topology",
    async () => {
      // With no reachable Podman engine the topology cannot be created. The
      // phase MUST report the failure as a closed ActualResult and MUST NOT
      // fall back to installing on the host.
      const outcome = await runInstallPhase(PROPERTY_ID, process.cwd(), {
        // Never actually runs an install here (topology creation fails first).
        timeoutSeconds: 5,
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        throw new Error(
          "expected the install phase to fail without a reachable Podman engine",
        );
      }

      // The failure is a closed non-VERDICT outcome tied to the property…
      expect(outcome.result.propertyId).toBe(PROPERTY_ID);
      // …and specifically NOT a verdict (a FAIL/PASS would imply a host run).
      expect(outcome.result.outcome).not.toBe("VERDICT");
      // It is one of the closed non-verdict outcomes (RUNNER_UNAVAILABLE when
      // Podman is absent/hung; the others only if a later control step fails).
      expect([
        "RUNNER_UNAVAILABLE",
        "EXECUTION_ERROR",
        "TIMEOUT",
        "SAFETY_VIOLATION",
      ]).toContain(outcome.result.outcome);
    },
    25_000,
  );
});

describe("install-phase topology — robust teardown (task 9.1)", () => {
  // Teardown must RESOLVE (never throw) for a topology that does not exist, so
  // the "dismantle before the test phase" guarantee holds on partial failure.
  // It shells out to `podman rm`/`podman network rm`, each bounded by the
  // module's own 30s control-timeout kill, so the test timeout clears 2×30s to
  // cover a hung (installed-but-not-started) Podman; a reachable or absent
  // Podman returns promptly. The point being proved is that teardown always
  // resolves regardless of which of those three states Podman is in.
  it(
    "tears down a never-created topology without throwing (idempotent, R5.4/R12.3)",
    async () => {
      const missing = {
        proxyContainerName: "spec-lantern-proxy-does-not-exist",
        networkName: "spec-lantern-install-net-does-not-exist",
      };

      await expect(teardownInstallTopology(missing)).resolves.toBeUndefined();
      // Calling it twice is also safe (idempotent).
      await expect(teardownInstallTopology(missing)).resolves.toBeUndefined();
    },
    140_000,
  );

  // Teardown must also resolve for a handle that carries the OUTBOUND network
  // (the full per-run shape), not only the two-field partial. A never-created
  // outbound network is likewise "already gone", not an error, so teardown of a
  // complete-but-nonexistent topology still resolves. This guards the branch
  // that removes `outboundNetworkName` when present.
  it(
    "tears down a never-created FULL topology (incl. outbound network) without throwing",
    async () => {
      const missingFull = {
        proxyContainerName: "spec-lantern-proxy-missing-full",
        networkName: "spec-lantern-install-net-missing-full",
        outboundNetworkName: "spec-lantern-out-net-missing-full",
      };

      await expect(
        teardownInstallTopology(missingFull),
      ).resolves.toBeUndefined();
    },
    140_000,
  );
});

describe("install-phase topology — setup failure still reaps (task 9.1, hardening)", () => {
  // When the topology cannot be stood up, createInstallTopology must surface a
  // CLOSED non-VERDICT result (RUNNER_UNAVAILABLE) and must NOT return a live
  // handle — i.e. nothing is left half-built for a caller to leak. Combined with
  // the module's try/catch-with-teardown around setup, this is the observable
  // contract that "teardown runs even when setup fails/throws midway": the
  // function never resolves to a dangling topology. Only assert this offline
  // (no reachable Podman) so we never stand up a real proxy here; the live path
  // is the task 10.5 container smoke test.
  it.skipIf(PODMAN_REACHABLE)(
    "returns a closed RUNNER_UNAVAILABLE (never a live handle) when setup cannot complete",
    async () => {
      const result = await createInstallTopology(PROPERTY_ID);

      // A live handle would have a registryUrl/runToken; a failure is the closed
      // ActualResult discriminated by `outcome`. We must get the failure shape.
      expect("outcome" in result).toBe(true);
      if (!("outcome" in result)) {
        throw new Error("expected a closed RUNNER_UNAVAILABLE, got a live handle");
      }
      expect(result.outcome).toBe("RUNNER_UNAVAILABLE");
      expect(result.propertyId).toBe(PROPERTY_ID);
    },
    30_000,
  );
});

describe("install-phase topology — startup reaper (task 9.1, hardening)", () => {
  // The startup reaper defends against a PRIOR hard-killed run whose own
  // `finally` could never execute (SIGKILL on a hung podman). It is prefix/label
  // scoped and no-throw/bounded, so it must RESOLVE regardless of whether Podman
  // is reachable, absent, or hung — and never throw. It removes only resources
  // matching this runner's own name prefixes (spec-lantern-proxy-* /
  // spec-lantern-install-net-* / spec-lantern-out-net-*), so running it on a
  // host with none of those present is a safe no-op that touches nothing else
  // (notably not the persistent Verdaccio cache volume). Bounded by the module's
  // 30s control-timeouts across up to a handful of podman calls, so the test
  // ceiling clears a hung engine.
  it(
    "reaps leftover install resources prefix-scoped and no-throw (idempotent)",
    async () => {
      await expect(reapLeftoverInstallResources()).resolves.toBeUndefined();
      // Idempotent: a second pass with nothing left is still a safe no-op.
      await expect(reapLeftoverInstallResources()).resolves.toBeUndefined();
    },
    140_000,
  );
});

describe("install-phase reaper — overlapping runs (regression)", () => {
  // Regression: the reaper once removed every prefixed resource, deleting the
  // network of another run that was still active ("unable to find network").
  // Two overlapping runs: A is alive (this process), B's owner has exited.
  const NET = "spec-lantern-install-net-";
  const OUT = "spec-lantern-out-net-";

  /** Spawn a short-lived child and return its pid once it has fully exited. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid as number;
    await new Promise((r) => child.on("close", r));
    return pid;
  }

  const never = async (): Promise<number | undefined> => undefined;

  it("keeps resources of a live owner and reaps those of a dead owner", async () => {
    const dead = await deadPid();
    const deps = {
      isPidAlive: (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      getCreatedMs: never,
      now: () => Date.now(),
    };
    const live = `${NET}${process.pid}-abcdef0123456789`;
    const gone = `${NET}${dead}-abcdef0123456789`;
    expect(await isProvablyOrphaned(live, NET, deps)).toBe(false);
    expect(await isProvablyOrphaned(gone, NET, deps)).toBe(true);
    expect(await isProvablyOrphaned(`${OUT}${process.pid}-0123456789abcdef`, OUT, deps)).toBe(false);
  });

  it("keeps legacy/unknown names unless provably old", async () => {
    const now = 1_000_000_000_000;
    const base = { isPidAlive: () => true, now: () => now };
    const legacy = `${NET}0123456789abcdef`;
    expect(await isProvablyOrphaned(legacy, NET, { ...base, getCreatedMs: never })).toBe(false);
    expect(await isProvablyOrphaned(legacy, NET, { ...base, getCreatedMs: async () => now - 60_000 })).toBe(false);
    expect(await isProvablyOrphaned(legacy, NET, { ...base, getCreatedMs: async () => now - 4 * 3_600_000 })).toBe(true);
  });

  it(
    "with real podman, a live run's network survives the reaper and a dead run's is removed",
    async (ctx) => {
      if (spawnSync("podman", ["info"], { timeout: 15_000 }).status !== 0) ctx.skip();
      const dead = await deadPid();
      const live = `${NET}${process.pid}-feedfacefeedface`;
      const gone = `${NET}${dead}-feedfacefeedface`;
      const exists = (n: string) =>
        spawnSync("podman", ["network", "exists", n]).status === 0;
      try {
        for (const n of [live, gone]) {
          expect(spawnSync("podman", ["network", "create", "--internal", n]).status).toBe(0);
        }
        await reapLeftoverInstallResources();
        expect(exists(live)).toBe(true);
        expect(exists(gone)).toBe(false);
      } finally {
        for (const n of [live, gone]) spawnSync("podman", ["network", "rm", "-f", n]);
      }
    },
    140_000,
  );
});
