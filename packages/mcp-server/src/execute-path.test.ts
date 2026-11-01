// Feature: spec-lantern — walking-skeleton smoke test (task 4.4)
//
// This is the smoke test that validates the wired walking skeleton end-to-end
// (tasks 4.1 artifacts → 4.2 rootless-Podman runner → 4.3 execute path). It is
// NOT a fast-check property; it is a single integration assertion that the one
// monthly-ordering Correctness_Property, when executed against the real
// writing-tracker Target_Repo through `executeWalkingSkeleton`, actually
// contradicts the comment-trusting PASS prediction.
//
// What it proves, mapped to requirements:
//   - R5.1 / R12.1 — the property EXECUTES INSIDE THE RUNNER, NEVER ON THE HOST.
//       `executeWalkingSkeleton` has exactly one execution path:
//       `runPropertyInContainer`, which runs the target's install + Vitest
//       inside a rootless Podman container and NEVER falls back to host
//       execution (it returns RUNNER_UNAVAILABLE instead). So a real VERDICT
//       outcome is only reachable via the container. We additionally assert the
//       READ-ONLY host source `sandbox/writing-tracker` was never mutated by the
//       run — in particular that the run did not install a `node_modules` into
//       the host source tree — demonstrating the target was installed and run
//       in the container, not on the host.
//   - R5.6 — the property yields a FAIL (the real code builds the 6 months
//       most-recent-first then calls `.reverse()`, so the first monthly row is
//       the OLDEST month, contradicting the comment's "most recent month
//       first"), and that FAIL carries a Counterexample with the triggering
//       input values and the observed output.
//
// Isolation / environment gating. This is a heavy, container-backed, online
// slice: the runner mounts the target working copy and runs Vitest in a
// rootless Podman container (pulling the Node image and installing the target
// deps on first run). To keep the regular host `npm test` fast and offline it
// is OPT-IN: it runs only when SPEC_LANTERN_SMOKE=1 (use `npm run test:smoke`).
// Without that flag it is skipped (visibly, via `it.skipIf`). When opted in but
// Podman is not reachable it is also skipped — the runner would correctly
// return RUNNER_UNAVAILABLE rather than run target code on the host, which is
// itself the R5.8/R12.5 no-host-fallback guarantee. Both skips are visible and
// never mask a failure — they only avoid asserting a slice this run should not
// (opt-out) or cannot (no Podman) execute.

import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeWalkingSkeleton } from "./execute-path.js";

const here = dirname(fileURLToPath(import.meta.url));
// Repo root from this source file: packages/mcp-server/src → repo root.
const REPO_ROOT = resolve(here, "..", "..", "..");
// The READ-ONLY host source Target_Repo the execute path copies OUT of.
const HOST_TARGET_SOURCE = resolve(REPO_ROOT, "sandbox", "writing-tracker");
const HOST_TARGET_NODE_MODULES = resolve(HOST_TARGET_SOURCE, "node_modules");

// Generous ceiling: the first container run pulls the Node image and installs
// the target's full dependency tree + the pinned test toolchain before running
// the one property's >=100 fast-check iterations. Subsequent runs are ~30s.
const E2E_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Probe whether rootless Podman is usable (binary present AND the engine/
 * machine reachable) using the same lightweight `podman info` check the runner
 * uses internally. Returns true only when Podman can actually run a container.
 */
async function podmanIsUsable(): Promise<boolean> {
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

/** True when a path exists on disk. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Opt-in: the regular host `npm test` must stay fast and offline, so this
// heavy container slice runs only when explicitly requested via
// SPEC_LANTERN_SMOKE=1 (`npm run test:smoke`). We only probe Podman — a
// subprocess spawn — when opted in, so a normal test run pays no cost.
const SMOKE_OPTED_IN = process.env.SPEC_LANTERN_SMOKE === "1";
const PODMAN_USABLE = SMOKE_OPTED_IN ? await podmanIsUsable() : false;
const RUN_SMOKE = SMOKE_OPTED_IN && PODMAN_USABLE;

describe("walking skeleton — single-property FAIL (task 4.4)", () => {
  // Skipped (visibly) unless opted in via SPEC_LANTERN_SMOKE=1 AND rootless
  // Podman is reachable; never silently passed. See the file header for why.
  it.skipIf(!RUN_SMOKE)(
    "executes the monthly-ordering property IN THE RUNNER (not the host) and yields FAIL with a Counterexample",
    async () => {
      // Snapshot the host source state before the run so we can prove the host
      // Target_Repo was not mutated (no install/run happened on the host).
      const hostNodeModulesBefore = await pathExists(HOST_TARGET_NODE_MODULES);
      const hostSourceMtimeBefore = (await stat(HOST_TARGET_SOURCE)).mtimeMs;

      const outcome = await executeWalkingSkeleton();

      /* ---- R5.1 / R12.1: executed inside the runner, never on the host ---- */

      // A real VERDICT is reachable ONLY through the Podman container path
      // inside `runPropertyInContainer`; the runner returns RUNNER_UNAVAILABLE
      // (never a host-run verdict) when Podman is absent. Observing a VERDICT
      // therefore proves the property executed in the runner, not the host.
      expect(outcome.actual.outcome).toBe("VERDICT");

      // The host SOURCE Target_Repo must be byte-for-byte untouched: the run
      // copies it into a gitignored working copy and installs/runs THERE (in
      // the container). In particular it must NOT have installed a node_modules
      // into the host source tree — that would be the fingerprint of a host-side
      // install. If node_modules did not exist before, it must not exist after.
      if (!hostNodeModulesBefore) {
        expect(await pathExists(HOST_TARGET_NODE_MODULES)).toBe(false);
      }
      // The host source directory itself must not have been written to by the
      // run (its mtime is unchanged).
      const hostSourceMtimeAfter = (await stat(HOST_TARGET_SOURCE)).mtimeMs;
      expect(hostSourceMtimeAfter).toBe(hostSourceMtimeBefore);

      /* ---- R5.6: FAIL that contradicts the comment-trusting PASS ---- */

      expect(outcome.predictedVerdict).toBe("PASS");
      expect(outcome.actualVerdict).toBe("FAIL");
      expect(outcome.predictionContradicted).toBe(true);

      // Narrow to the VERDICT shape to inspect the verdict + counterexample.
      if (outcome.actual.outcome !== "VERDICT") {
        throw new Error(
          `expected a VERDICT outcome, got ${outcome.actual.outcome}`,
        );
      }
      expect(outcome.actual.verdict).toBe("FAIL");

      /* ---- R5.6: the FAIL carries a Counterexample (input + output) ---- */

      const counterexample = outcome.actual.counterexample;
      expect(counterexample).toBeDefined();
      // The Counterexample is tied to the same property.
      expect(counterexample?.propertyId).toBe("property-1.claim-monthly-order");
      // It contains the triggering input values…
      expect(counterexample?.input).toBeDefined();
      expect(counterexample?.input).not.toBeNull();
      // …and the observed output (the oldest-month-first row the real code
      // rendered instead of the comment-promised current month).
      expect(typeof counterexample?.observedOutput).toBe("string");
      expect((counterexample?.observedOutput ?? "").length).toBeGreaterThan(0);
      // It records the Execution_Context so the FAIL is replayable.
      expect(counterexample?.executionContext).toBeDefined();
    },
    E2E_TIMEOUT_MS,
  );
});
