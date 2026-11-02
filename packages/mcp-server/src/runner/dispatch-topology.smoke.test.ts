// Feature: spec-lantern — runner-dispatch + install-topology smoke test (task 10.5)
//
// This is the REQUIRED integration smoke test for the product's core safety
// guarantee: Target_Repo code is dispatched INTO the rootless Podman runner,
// NEVER onto the host, and the Dependency_Install_Phase network topology lets
// the install container reach ONLY the package registry (the Verdaccio proxy)
// with NO direct outbound internet route. Unlike the fast-check properties in
// task 8.3 / 9.3, this is a pair of live-engine integration assertions against
// REAL Podman — it stands up real containers and a real network.
//
// What it proves, mapped to requirements:
//
//   1. Runner dispatch (R5.1, R5.3). A Property_Execution_Request for the
//      walking-skeleton monthly-ordering property is dispatched through the
//      REAL default `IsolatedRunner` (the local rootless Podman two-phase
//      runner, `getIsolatedRunner()`, the same contract `executeProperties`
//      drives) against a working copy of the writing-tracker reference
//      Target_Repo. A real VERDICT is reachable ONLY through the Podman
//      container path (`runTwoPhase`): with no reachable Podman the runner
//      returns RUNNER_UNAVAILABLE and NEVER a host-run verdict (the R5.8/R12.5
//      no-host-fallback guarantee). So observing a VERDICT PROVES the property
//      executed IN THE CONTAINER, not on the host. We additionally assert the
//      READ-ONLY host source `sandbox/writing-tracker` was never mutated by the
//      run — in particular that the run did not install a `node_modules` into
//      the host source tree — the fingerprint a host-side install would leave.
//      The working copy is prepared by the SAME production seam the skeleton
//      execute path uses (`prepareWalkingSkeletonWorkingCopy`), not duplicated
//      here.
//
//   2. Install-phase topology (R12.2). We stand up the REAL install-phase
//      topology via `createInstallTopology` (the internal-only Podman network +
//      the single outbound-capable Verdaccio registry proxy, dual-attached to
//      the internal network and a dedicated outbound network). We then run a
//      PROBE container attached to EXACTLY the same single internal network the
//      install container uses, and assert from inside it that:
//        - the proxy IS reachable (a TCP connect to the proxy's registry port
//          on the internal network succeeds), and
//        - a DIRECT outbound internet route does NOT exist (a TCP connect to a
//          well-known public host:port fails — the install container's only way
//          out is through the proxy, exactly as R12.2 requires).
//      The probe NEVER runs Target_Repo code; it is a tiny Node TCP check run
//      by the install image's own `node` binary. The topology is always torn
//      down in a `finally` via the module's own `teardownInstallTopology`.
//
// Isolation / environment gating (matches execute-path.test.ts exactly). This
// is a heavy, container-backed, online slice (it pulls images, installs the
// target's deps through the proxy, and stands up a real network). To keep the
// regular host `npm test` fast and offline it is OPT-IN: it runs only when
// SPEC_LANTERN_SMOKE=1. Without that flag it is skipped (visibly, via
// `it.skipIf`). When opted in but Podman is not reachable it is also skipped —
// the runner would correctly return RUNNER_UNAVAILABLE rather than run target
// code on the host, which is itself the no-host-fallback guarantee. Both skips
// are visible and never mask a failure.

import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  prepareWalkingSkeletonWorkingCopy,
  WALKING_SKELETON_PROPERTY_ID,
  WALKING_SKELETON_TARGET_SOURCE,
} from "../execute-path.js";
import { getIsolatedRunner } from "./isolated-runner.js";
import {
  createInstallTopology,
  teardownInstallTopology,
  type InstallTopology,
} from "./install-phase.js";

// The READ-ONLY host source Target_Repo the dispatch half copies OUT of
// (the same `sandbox/writing-tracker` the walking-skeleton execute path uses).
const HOST_TARGET_SOURCE = WALKING_SKELETON_TARGET_SOURCE;
const HOST_TARGET_NODE_MODULES = resolve(HOST_TARGET_SOURCE, "node_modules");

// This smoke test gets its OWN working copy so it never races the skeleton
// execute path (run concurrently in the same `test:smoke` invocation). We let
// the production seam (`prepareWalkingSkeletonWorkingCopy`) choose a UNIQUE
// per-run directory name (a `.worktree-<token>` suffix) rather than a fixed
// name — fixed names let two concurrent runs delete each other's files mid-copy
// (ENOTEMPTY). The chosen path comes back on `prepared.worktreeDir`; we clean it
// up in `finally`. It lives under the repo (under `/Users`) so it is visible
// inside the macOS Podman machine, which shares `/Users` not /tmp.

// The install image the topology probe shells into. Must match the install
// phase's own default so `node` resolves identically. Kept in sync with
// install-phase.ts's DEFAULT_INSTALL_IMAGE.
const INSTALL_IMAGE = "docker.io/library/node:20-bookworm-slim";

// The Verdaccio registry port the install container points its registry at
// (install-phase.ts PROXY_PORT). The proxy is reachable at its container name
// on the shared internal network.
const PROXY_PORT = 4873;

// Generous ceiling: the dispatch half's first container run pulls the Node
// image and installs the target's full dependency tree + the pinned test
// toolchain through the cold proxy before running the property's >=100
// fast-check iterations. Subsequent runs are far faster.
const E2E_TIMEOUT_MS = 10 * 60 * 1000;

// Standing up the install topology (create internal + outbound networks, start
// Verdaccio, pull the proxy image on first run) plus two short probe containers.
const TOPOLOGY_TIMEOUT_MS = 5 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Gating — identical convention to execute-path.test.ts                      */
/* -------------------------------------------------------------------------- */

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

/** Minimal result of a raw `podman` invocation (probe/teardown only). */
interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run `podman` (never Target_Repo code), capturing stdout/stderr with a bounded
 * timeout. Used only for the topology probe containers in this test.
 */
function runPodman(args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += `\n${err.message}`;
      resolvePromise({ code: null, stdout, stderr, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

// Opt-in: the regular host `npm test` must stay fast and offline, so this heavy
// container slice runs only when explicitly requested via SPEC_LANTERN_SMOKE=1
// (see package.json's test:smoke). We only probe Podman — a subprocess spawn —
// when opted in, so a normal test run pays no cost.
const SMOKE_OPTED_IN = process.env.SPEC_LANTERN_SMOKE === "1";
const PODMAN_USABLE = SMOKE_OPTED_IN ? await podmanIsUsable() : false;
const RUN_SMOKE = SMOKE_OPTED_IN && PODMAN_USABLE;

/* -------------------------------------------------------------------------- */
/* Part 1 — runner dispatch into the rootless Podman runner (R5.1, R5.3)      */
/* -------------------------------------------------------------------------- */

describe("runner dispatch — property executes IN THE RUNNER, not the host (task 10.5)", () => {
  // Skipped (visibly) unless opted in via SPEC_LANTERN_SMOKE=1 AND rootless
  // Podman is reachable; never silently passed. See the file header.
  it.skipIf(!RUN_SMOKE)(
    "dispatches a Property_Execution_Request into the rootless Podman runner and yields a container-produced VERDICT (R5.1, R5.3)",
    async () => {
      // Prepare the writing-tracker working copy via the SAME production seam
      // the skeleton execute path uses (no duplicated setup logic here).
      // No fixed worktreeDir — the seam picks a unique per-run directory.
      const prepared = await prepareWalkingSkeletonWorkingCopy();
      expect(prepared.propertyId).toBe(WALKING_SKELETON_PROPERTY_ID);

      try {
        // Snapshot the host SOURCE state before the run so we can prove the host
        // Target_Repo was not mutated (no install/run happened on the host).
        const hostNodeModulesBefore = await pathExists(HOST_TARGET_NODE_MODULES);
        const hostSourceMtimeBefore = (await stat(HOST_TARGET_SOURCE)).mtimeMs;

        // Dispatch through the REAL default Isolated_Runner — the SAME contract
        // `executeProperties` drives for every accepted property (gate → runner).
        // A real VERDICT is reachable ONLY through the Podman container path:
        // the runner returns RUNNER_UNAVAILABLE rather than running on the host
        // when Podman is absent, so a VERDICT is proof of in-container execution.
        const runner = getIsolatedRunner();
        const actual = await runner.runProperty({
          propertyId: prepared.propertyId,
          targetRepoPath: prepared.worktreeDir,
          propertyTestFile: prepared.propertyTestFile,
          // Generous: phase one installs React + Radix + the pinned toolchain
          // through the cold proxy before phase two runs the property.
          timeoutSeconds: 600,
        });

        /* ---- R5.1 / R5.3: dispatched into the runner, never the host ---- */

        // The property executed inside the rootless Podman container: observing
        // a VERDICT (PASS/FAIL) is only possible via the container path.
        expect(actual.outcome).toBe("VERDICT");
        expect(actual.propertyId).toBe(prepared.propertyId);

        // The host SOURCE Target_Repo must be byte-for-byte untouched: the run
        // copies it into a gitignored working copy and installs/runs THERE (in
        // the container). It must NOT have installed a node_modules into the
        // host source tree — the fingerprint of a host-side install.
        if (!hostNodeModulesBefore) {
          expect(await pathExists(HOST_TARGET_NODE_MODULES)).toBe(false);
        }
        // The host source directory itself must not have been written to.
        const hostSourceMtimeAfter = (await stat(HOST_TARGET_SOURCE)).mtimeMs;
        expect(hostSourceMtimeAfter).toBe(hostSourceMtimeBefore);
      } finally {
        // Clean this run's unique working copy so nothing leaks between runs.
        const { rm } = await import("node:fs/promises");
        await rm(prepared.worktreeDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    },
    E2E_TIMEOUT_MS,
  );
});

/* -------------------------------------------------------------------------- */
/* Part 2 — install-phase topology: proxy reachable, no direct outbound (R12.2)*/
/* -------------------------------------------------------------------------- */

// Track any topology we stand up so afterAll can guarantee teardown even if an
// assertion throws before the test's own finally runs.
let standingTopology: InstallTopology | undefined;

afterAll(async () => {
  if (standingTopology) {
    await teardownInstallTopology(standingTopology).catch(() => undefined);
    standingTopology = undefined;
  }
});

describe("install-phase topology — registry only, no direct outbound (task 10.5, R12.2)", () => {
  it.skipIf(!RUN_SMOKE)(
    "the install container reaches the proxy but has NO direct outbound internet route",
    async () => {
      // Stand up the REAL install topology (internal-only network + outbound
      // network + dual-attached Verdaccio proxy). This is the same topology the
      // install container runs inside.
      const topology = await createInstallTopology(WALKING_SKELETON_PROPERTY_ID);

      // createInstallTopology returns a RUNNER_UNAVAILABLE ActualResult (not a
      // handle) if it could not stand the topology up. With Podman reachable
      // (RUN_SMOKE gate) this should be a handle; fail loudly otherwise.
      if ("outcome" in topology) {
        throw new Error(
          `expected an install topology handle, got ${topology.outcome}: ` +
            `${"reason" in topology ? topology.reason : ""}`,
        );
      }
      standingTopology = topology;

      try {
        // Give Verdaccio a moment to bind its port inside the container before
        // probing it. The proxy was started detached; poll until the TCP port
        // is accepting on the internal network (bounded), so we do not race it.
        // A short initial settle keeps the first probe from a cold-start miss.
        await new Promise((r) => setTimeout(r, 2_000));

        // PROBE A — proxy reachability. A container attached to EXACTLY the same
        // single internal network the install container uses must be able to
        // open a TCP connection to the proxy at its container name:port. We poll
        // a few times to absorb Verdaccio's startup, treating a connect within
        // the window as success.
        const proxyReachable = await probeTcpFromInternalNetwork(
          topology,
          topology.proxyContainerName,
          PROXY_PORT,
          // Retry window: Verdaccio can take a few seconds to accept.
          { attempts: 10, perAttemptTimeoutMs: 4_000, expect: "open" },
        );
        expect(proxyReachable.open).toBe(true);

        // PROBE B — NO direct outbound internet route. The SAME internal-only
        // network must NOT provide a direct route to the public internet. A TCP
        // connect to a well-known public host:port (the npm registry's HTTPS
        // endpoint, 443) must FAIL from the internal network — the install
        // container's only way out is through the proxy, exactly as R12.2
        // requires. DNS may or may not resolve on the internal net; either an
        // unresolved host or a failed/timed-out connect counts as "no direct
        // route". We give it a real chance to connect (so a pass is meaningful)
        // and assert it does not.
        const directOutbound = await probeTcpFromInternalNetwork(
          topology,
          "registry.npmjs.org",
          443,
          { attempts: 1, perAttemptTimeoutMs: 8_000, expect: "closed" },
        );
        expect(directOutbound.open).toBe(false);
      } finally {
        await teardownInstallTopology(topology).catch(() => undefined);
        standingTopology = undefined;
      }
    },
    TOPOLOGY_TIMEOUT_MS,
  );
});

/* -------------------------------------------------------------------------- */
/* Topology TCP probe helper                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run a throwaway container attached to EXACTLY the install topology's internal
 * network (the same single network the install container uses) and attempt a
 * raw TCP connection to `host:port` from inside it, using the install image's
 * own `node` binary (never Target_Repo code). Returns whether the socket opened.
 *
 * This reproduces the install container's network vantage point precisely: it
 * is attached to ONLY `topology.networkName` (the internal-only network), so
 * what it can and cannot reach is exactly what the install step can and cannot
 * reach. Reaching the proxy proves the registry is available; failing to reach
 * a public host proves there is no direct outbound route (R12.2).
 *
 * @param expect "open" polls until the socket connects (proxy reachability);
 *   "closed" tries once and reports whether it connected (direct-outbound check).
 */
async function probeTcpFromInternalNetwork(
  topology: InstallTopology,
  host: string,
  port: number,
  options: { attempts: number; perAttemptTimeoutMs: number; expect: "open" | "closed" },
): Promise<{ open: boolean }> {
  // A tiny Node program that opens a TCP socket and prints OPEN/CLOSED. It never
  // imports or runs any Target_Repo code — it is pure `node:net` run by the
  // install image's node. Timeout/err/unreachable all resolve to CLOSED.
  const probeScript = [
    "const net=require('net');",
    `const s=net.connect({host:${JSON.stringify(host)},port:${port}});`,
    `s.setTimeout(${Math.max(1000, options.perAttemptTimeoutMs - 500)});`,
    "let done=false;",
    "const fin=(v)=>{if(done)return;done=true;try{s.destroy()}catch(e){};process.stdout.write(v);process.exit(0)};",
    "s.on('connect',()=>fin('OPEN'));",
    "s.on('timeout',()=>fin('CLOSED'));",
    "s.on('error',()=>fin('CLOSED'));",
  ].join("");

  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const res = await runPodman(
      [
        "run",
        "--rm",
        // ATTACH TO ONLY THE INTERNAL NETWORK — the install container's exact
        // vantage point. No outbound network here.
        "--network",
        topology.networkName,
        INSTALL_IMAGE,
        "node",
        "-e",
        probeScript,
      ],
      options.perAttemptTimeoutMs + 20_000,
    );
    const open = res.stdout.includes("OPEN");
    if (options.expect === "open") {
      if (open) return { open: true };
      // Not yet accepting — back off briefly and retry (Verdaccio warm-up).
      await new Promise((r) => setTimeout(r, 1_500));
    } else {
      // Single-shot closed check: report whatever the one connect attempt saw.
      return { open };
    }
  }
  return { open: false };
}
