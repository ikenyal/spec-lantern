/**
 * The install-phase network topology (task 9.1).
 *
 * This module constructs — and, just as importantly, tears down — the
 * Dependency_Install_Phase half of the runner's two-phase lifecycle (design
 * "Two-Phase Execution Lifecycle"). Its single responsibility is the NETWORK
 * TOPOLOGY that realizes the "package registry only" guarantee (R12.2) while
 * dependencies are installed, and then DISMANTLING that topology before the
 * Test_Execution_Phase (task 9.2) begins so the two-phase split holds (R5.4,
 * R12.3).
 *
 * WHY TOPOLOGY, NOT EGRESS FILTERING. Rootless Podman cannot natively allowlist
 * outbound domains, so "only the package registry is reachable during install"
 * is enforced by the SHAPE of the network rather than by filtering egress. The
 * install phase runs two containers:
 *
 *  1. An INTERNAL-ONLY Podman network (`podman network create --internal`) that
 *     has NO direct route to the internet. The install container is attached to
 *     ONLY this network, so it cannot reach anything on the public internet by
 *     itself.
 *  2. An INSTALL container that holds the Target_Repo working directory and runs
 *     the package manager with lifecycle scripts disabled
 *     (`npm install --ignore-scripts`, R12.2). Because it lives only on the
 *     internal network its one reachable peer is the registry proxy; its npm
 *     registry is pointed at the proxy (`--registry http://<proxy>:4873`).
 *  3. A single REGISTRY-PROXY container (Verdaccio) that is the ONLY container
 *     granted outbound internet access. It is DUAL-ATTACHED: to the internal
 *     network (so the install container can reach it) AND to a SEPARATE,
 *     non-internal outbound network created just for it (so it — and only it —
 *     can reach the real registry). A container on only an `--internal` network
 *     has no egress at all, so the dedicated outbound network is what actually
 *     gives the proxy its uplink; without it every uncached package 404s. The
 *     proxy is therefore the sole bridge between the install container and the
 *     outside world, and the only thing reachable from the install step is the
 *     package registry, exactly as R12.2 requires.
 *
 * TWO-PHASE SPLIT. The Test_Execution_Phase runs with no network at all
 * (task 9.2). To keep that split honest, {@link teardownInstallTopology} removes
 * the proxy container AND both networks (internal + outbound), and this module's
 * orchestration entry point ({@link runInstallPhase}) always tears the topology
 * down in a `finally`, so no install-phase network or container survives into
 * the test phase — even on failure.
 *
 * HOST-SAFETY INVARIANTS (identical discipline to {@link ./test-phase.ts},
 * see steering 00-pipeline-and-safety.md):
 *  1. No host execution — the package manager runs ONLY via `podman run`, never
 *     in the host shell. There is no code path here that runs the Target_Repo's
 *     install on the host.
 *  2. No host fallback — if Podman is absent or any topology piece cannot be
 *     created, this module surfaces a `RUNNER_UNAVAILABLE` {@link ActualResult}
 *     (the same closed shape the skeleton runner uses) and stops; it never
 *     degrades to installing on the host.
 *  3. Boundary confinement — the install container mounts ONLY the target
 *     working directory it was handed; file access is confined to that mount.
 *  4. `--ignore-scripts` is preserved — the invariant defended all the way back
 *     in the skeleton runner is kept here, now backed by the full topology.
 *
 * macOS MOUNT DISCIPLINE (hard constraints, shared with {@link ./test-phase.ts}):
 *  - The target directory is bound with a PLAIN bind mount. No `:Z` SELinux
 *    relabel — macOS is not an SELinux host and relabeling a broad shared path
 *    is wrong there.
 *  - Only the specific target working directory is mounted. Never `$HOME`, never
 *    any other broad path.
 *  - Nothing the container must see is placed under host `/tmp`. The macOS
 *    Podman machine shares `/Users` but NOT the host `/tmp`, so every path the
 *    install container reads or writes lives UNDER THE MOUNTED REPO (under
 *    `/Users`), visible in the VM.
 *
 * SCOPE. This task builds and tears down the INSTALL-phase topology and runs the
 * install inside it. It deliberately does NOT run the Test_Execution_Phase —
 * that is task 9.2 — and exposes a clean lifecycle contract
 * ({@link createInstallTopology} → {@link runInstallInContainer} →
 * {@link teardownInstallTopology}, orchestrated by {@link runInstallPhase}) that
 * task 9.2's no-network test phase can sequence AFTER the install topology has
 * been torn down.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { ActualResult } from "@spec-lantern/types";
import { PINNED_TEST_TOOLCHAIN } from "./vitest-classify.js";

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Default registry-proxy image. Verdaccio is a lightweight npm registry proxy
 * that upstreams to the real registry; it is the single outbound-capable peer
 * the install container talks to (design "Two-Phase Execution Lifecycle").
 */
const DEFAULT_PROXY_IMAGE = "docker.io/verdaccio/verdaccio:6";

/**
 * Default install image: Node LTS with npm available, matching the skeleton
 * runner's base so the pinned toolchain resolves identically.
 */
const DEFAULT_INSTALL_IMAGE = "docker.io/library/node:20-bookworm-slim";

/** Where the target repo working directory is mounted inside the container. */
const CONTAINER_WORKDIR = "/work";

/** The port Verdaccio listens on inside the container (its documented default). */
const PROXY_PORT = 4873;

/**
 * Verdaccio's storage directory INSIDE the proxy container (its documented
 * default). The package cache + the registry's metadata live here; persisting
 * it across runs is what turns every install after the first into a warm,
 * mostly-offline fetch instead of re-downloading the whole tree each time.
 */
const PROXY_STORAGE_DIR = "/verdaccio/storage";

/**
 * Name of the NAMED Podman volume that persists Verdaccio's storage across runs
 * (the package cache). A named volume (not a bind mount) keeps the cache inside
 * the Podman machine — so it works identically on macOS where host /tmp is not
 * shared — and is reused by every run's freshly-named proxy container. It is
 * intentionally NOT torn down with the per-run topology: its whole purpose is to
 * outlive a run so the next install is warm. `podman volume create` is
 * idempotent (a second create is a no-op), so first run creates it and every
 * later run reuses it.
 */
const VERDACCIO_CACHE_VOLUME = "spec-lantern-verdaccio-cache";

/**
 * Default overall install-phase timeout in seconds. Installing a full
 * dependency tree through a cold proxy is slow on first run, so the default is
 * generous; callers pin a tighter value when appropriate.
 */
const DEFAULT_INSTALL_TIMEOUT_SECONDS = 600;

/** Timeout for short podman control-plane commands (network/container mgmt). */
const CONTROL_TIMEOUT_MS = 30_000;

/**
 * How many times teardown retries removing the internal network. In rootless
 * Podman a just-force-removed container can briefly keep the network pinned, so
 * the first `network rm` can transiently fail; retrying a few times with a short
 * backoff reliably clears it instead of leaking a `spec-lantern-install-net-*`.
 */
const NETWORK_RM_MAX_ATTEMPTS = 5;

/** Backoff between network-removal retries (ms). */
const NETWORK_RM_BACKOFF_MS = 500;

/**
 * Name prefixes of the PER-RUN install-phase resources (every name embeds a
 * unique run token after the prefix). The startup reaper
 * ({@link reapLeftoverInstallResources}) scopes itself to EXACTLY these
 * prefixes so it can only ever touch this runner's own install-phase
 * containers/networks — never an unrelated container or network a user happens
 * to have. Keep these in lock-step with the names built in
 * {@link createInstallTopology}.
 */
const PROXY_CONTAINER_PREFIX = "spec-lantern-proxy-";
const INSTALL_NETWORK_PREFIX = "spec-lantern-install-net-";
const OUTBOUND_NETWORK_PREFIX = "spec-lantern-out-net-";
const INSTALL_CONTAINER_PREFIX = "spec-lantern-install-";

/* -------------------------------------------------------------------------- */
/* Raw process helper (podman only — never Target_Repo code)                  */
/* -------------------------------------------------------------------------- */

/** Result of a raw process invocation. */
interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command, capturing stdout/stderr. Never runs Target_Repo code — callers
 * only use this for `podman` itself. An optional timeout kills the client; the
 * containers/network are reaped separately by the caller's teardown so nothing
 * stray survives.
 *
 * This mirrors the helper in {@link ./test-phase.ts} deliberately: the two
 * modules share the same spawn/timeout/no-host-execution discipline, and
 * duplicating the few lines keeps each runner module self-contained around the
 * one external binary it shells out to.
 */
function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<ProcResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      stderr += `\n${err.message}`;
      resolvePromise({ code: null, signal: null, stdout, stderr, timedOut });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * Detect whether Podman is usable (binary present AND the machine/engine is
 * reachable). Returns a reason string when unavailable, or null when ready.
 * Identical probe to the skeleton runner's so the no-host-fallback guarantee is
 * uniform across both runner modules.
 */
async function detectPodmanUnavailable(): Promise<string | null> {
  const probe = await runProcess(
    "podman",
    ["info", "--format", "{{.Version.Version}}"],
    { timeoutMs: 15_000 },
  );
  if (probe.timedOut) {
    return "podman info timed out — the Podman engine/machine is unreachable";
  }
  if (probe.code === null) {
    return `podman is not available on PATH or failed to launch: ${probe.stderr.trim()}`;
  }
  if (probe.code !== 0) {
    return `podman engine is not usable (podman info exited ${probe.code}): ${probe.stderr.trim()}`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Topology handle                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The live install-phase topology: the internal-only network, a SEPARATE
 * outbound-capable network, and the running registry-proxy container
 * (dual-attached to both), with the in-container registry URL the install
 * container must point at.
 *
 * WHY TWO NETWORKS. The install container must have NO direct route to the
 * internet, so it is attached to ONLY the internal-only network. But the proxy
 * must reach the real registry to upstream packages — and a container attached
 * to ONLY an `--internal` network has no outbound route at all (verified: DNS
 * and egress both fail). So the proxy is dual-attached: the internal network
 * (reachable by the install container at the proxy's container name) AND a
 * dedicated, non-internal outbound network that provides the egress route to
 * the real registry. The proxy is therefore the SOLE bridge between the
 * internal install step and the outside world, exactly as R12.2 requires.
 *
 * A handle is returned by {@link createInstallTopology} and consumed by
 * {@link runInstallInContainer} (which attaches the install container to ONLY
 * the internal network) and {@link teardownInstallTopology} (which removes the
 * proxy container and BOTH networks). All names embed a unique run token so
 * concurrent runs never collide and teardown can force-remove precisely.
 */
export interface InstallTopology {
  /** Name of the internal-only Podman network (no direct outbound route). */
  networkName: string;
  /**
   * Name of the SEPARATE, non-internal outbound network the proxy is also
   * attached to so it (and only it) can reach the real registry. The install
   * container is NEVER attached to this network.
   */
  outboundNetworkName: string;
  /** Name of the running registry-proxy (Verdaccio) container. */
  proxyContainerName: string;
  /**
   * The registry URL the INSTALL container points its package manager at,
   * expressed from inside the internal network: `http://<proxy>:<port>`. The
   * proxy is reachable at its container name on the shared internal network.
   */
  registryUrl: string;
  /** The unique token shared by all names in this topology (for teardown). */
  runToken: string;
}

/* -------------------------------------------------------------------------- */
/* Topology construction                                                      */
/* -------------------------------------------------------------------------- */

/** Build a short unique token used to name this run's network + containers. */
function makeRunToken(): string {
  return createHash("sha1")
    .update(`${Date.now()}:${randomBytes(6).toString("hex")}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Stand up the install-phase topology:
 *  1. Create an INTERNAL-ONLY Podman network (`--internal`): no direct route to
 *     the internet. The install container will live ONLY here.
 *  2. Create a SEPARATE, non-internal OUTBOUND network. Only the proxy is
 *     attached to this; it is what gives the proxy (and only the proxy) a route
 *     to the real registry. A container on ONLY an `--internal` network has no
 *     egress at all, so this second network is required — without it the proxy
 *     cannot upstream and every uncached package 404s.
 *  3. Start the registry-proxy (Verdaccio) container DUAL-ATTACHED to both
 *     networks: the internal one (reachable by the install container at its
 *     container name, `http://<proxyContainerName>:<PROXY_PORT>`) and the
 *     outbound one (its route to the real registry). It is the single
 *     outbound-capable peer and the sole bridge between the internal install
 *     step and the outside world (R12.2).
 *
 * Returns an {@link InstallTopology} handle on success, or a
 * `RUNNER_UNAVAILABLE` {@link ActualResult} (never a host fallback) when Podman
 * is unavailable or any piece cannot be created. On partial failure it tears
 * down whatever it created so no stray network/container survives.
 *
 * @param propertyId propagated onto a RUNNER_UNAVAILABLE result so the failure
 *   is self-describing (matches the skeleton runner's result shape).
 * @param options.proxyImage registry-proxy image (defaults to Verdaccio).
 */
export async function createInstallTopology(
  propertyId: string,
  options: { proxyImage?: string } = {},
): Promise<InstallTopology | Extract<ActualResult, { outcome: "RUNNER_UNAVAILABLE" }>> {
  const unavailableReason = await detectPodmanUnavailable();
  if (unavailableReason) {
    return { propertyId, outcome: "RUNNER_UNAVAILABLE", reason: unavailableReason };
  }

  // Defense against a PRIOR hard-killed run (SIGKILL on a hung podman) whose
  // own `finally` teardown could never run: before standing anything up, reap
  // any leftover install-phase proxy containers / install networks by name
  // prefix. Prefix-scoped and no-throw, so it can only touch THIS runner's own
  // resources and never makes setup fail or hang (see
  // {@link reapLeftoverInstallResources}). Leaving it here — rather than only in
  // teardown — is what closes the hard-kill leak: the next run always starts by
  // reaping what the killed one left behind.
  await reapLeftoverInstallResources();

  const runToken = makeRunToken();
  const networkName = `${INSTALL_NETWORK_PREFIX}${runToken}`;
  const outboundNetworkName = `${OUTBOUND_NETWORK_PREFIX}${runToken}`;
  const proxyContainerName = `${PROXY_CONTAINER_PREFIX}${runToken}`;
  const proxyImage = options.proxyImage ?? DEFAULT_PROXY_IMAGE;

  // A partial handle used so any early-exit cleanup goes through the hardened
  // teardown (which removes the proxy and BOTH networks, retrying the network
  // removals) — this is what keeps a half-built topology from leaking.
  const partial = { proxyContainerName, networkName, outboundNetworkName };

  // Every setup step runs under this try so ANY failure mode — a non-zero
  // podman exit handled explicitly below, OR an unexpected THROW partway
  // through (e.g. podman spawns but the promise rejects, or a later step
  // throws after the proxy is already up) — routes through the hardened
  // teardown of the PARTIAL handle. Without this, a throw between "proxy
  // started" and "return" would leave the proxy + both networks running with
  // nothing to reap them. The teardown is no-throw and bounded, so the catch
  // can never itself hang or mask the original error.
  try {
    // 1. Internal-only network — the crux of the R12.2 guarantee. `--internal`
    //    means containers on it have NO direct route to the internet; the only
    //    way out is through the proxy.
    const netCreate = await runProcess(
      "podman",
      ["network", "create", "--internal", networkName],
      { timeoutMs: CONTROL_TIMEOUT_MS },
    );
    if (netCreate.code !== 0) {
      // The internal network is the FIRST piece; if it failed nothing stray was
      // created yet, but route through teardown anyway (idempotent, no-throw) so
      // a partially-created network is still reaped.
      await teardownInstallTopology(partial).catch(() => undefined);
      return {
        propertyId,
        outcome: "RUNNER_UNAVAILABLE",
        reason: `could not create internal install network: ${netCreate.stderr.trim().slice(0, 500)}`,
      };
    }

    // 2. Outbound network — NON-internal, so a container attached to it has a
    //    route to the real registry. Only the proxy is ever attached here.
    const outCreate = await runProcess(
      "podman",
      ["network", "create", outboundNetworkName],
      { timeoutMs: CONTROL_TIMEOUT_MS },
    );
    if (outCreate.code !== 0) {
      await teardownInstallTopology(partial).catch(() => undefined);
      return {
        propertyId,
        outcome: "RUNNER_UNAVAILABLE",
        reason: `could not create outbound proxy network: ${outCreate.stderr.trim().slice(0, 500)}`,
      };
    }

    // 2b. Ensure the PERSISTENT Verdaccio cache volume exists. Idempotent: the
    //     first run creates it, every later run reuses the warm cache. Mounted
    //     into the proxy below so packages fetched once are not re-downloaded.
    //     A failure here is non-fatal — we fall back to a cold (but correct)
    //     proxy rather than failing the run, so the cache is a pure speed-up.
    await runProcess("podman", ["volume", "create", VERDACCIO_CACHE_VOLUME], {
      timeoutMs: CONTROL_TIMEOUT_MS,
    }).catch(() => undefined);

    // 3. Start the registry proxy, detached (`-d`) and DUAL-ATTACHED: the
    //    internal network (so the install container reaches it at its container
    //    name) AND the outbound network (so it — and only it — can reach the
    //    real registry to upstream packages). Two `--network` flags attach both
    //    at run time. The persistent cache volume is mounted at Verdaccio's
    //    storage dir so the package cache survives across runs (the first
    //    install is cold; later ones are warm). The volume is deliberately NOT
    //    removed by teardown — it must outlive the per-run topology to be a cache.
    const proxyRun = await runProcess(
      "podman",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        proxyContainerName,
        "--network",
        networkName,
        "--network",
        outboundNetworkName,
        "-v",
        `${VERDACCIO_CACHE_VOLUME}:${PROXY_STORAGE_DIR}`,
        proxyImage,
      ],
      { timeoutMs: CONTROL_TIMEOUT_MS },
    );
    if (proxyRun.code !== 0) {
      // Tear down what we created so nothing stray survives — route through the
      // hardened teardown so BOTH networks are reaped even if the proxy
      // half-started and briefly pins one (the retrying `network rm` closes that
      // leak).
      await teardownInstallTopology(partial).catch(() => undefined);
      return {
        propertyId,
        outcome: "RUNNER_UNAVAILABLE",
        reason: `could not start registry proxy: ${proxyRun.stderr.trim().slice(0, 500)}`,
      };
    }

    return {
      networkName,
      outboundNetworkName,
      proxyContainerName,
      // The install container resolves the proxy by its container name on the
      // shared internal network.
      registryUrl: `http://${proxyContainerName}:${PROXY_PORT}`,
      runToken,
    };
  } catch (err) {
    // An UNEXPECTED throw partway through setup (not a handled non-zero exit).
    // Reap the partial topology so the proxy + both networks can never survive
    // a mid-setup failure, then surface the failure as a closed
    // RUNNER_UNAVAILABLE (never a host fallback). teardown is no-throw/bounded.
    await teardownInstallTopology(partial).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    return {
      propertyId,
      outcome: "RUNNER_UNAVAILABLE",
      reason: `could not stand up install topology: ${message.slice(0, 500)}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Install execution inside the topology                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compose the shell script that runs ENTIRELY INSIDE the install container:
 * point npm at the proxy registry, then install the target's deps with
 * lifecycle scripts disabled.
 *
 * `--ignore-scripts` is NON-NEGOTIABLE (R12.2) — it is the defense that keeps a
 * malicious `postinstall` from running even though the network is already
 * topology-confined to the registry. `--registry <proxy>` forces every fetch
 * through the single outbound-capable peer, so the install cannot reach anything
 * but the package registry.
 *
 * It installs TWO things while the proxy is reachable: the target's own
 * dependencies, and the PINNED test toolchain (Vitest + fast-check + jsdom +
 * testing-library). The latter must be fetched here because the subsequent
 * no-network Test_Execution_Phase (task 9.2) cannot reach any registry — the
 * test runner has to already be on disk when that phase starts.
 *
 * Executed by the container's shell via `podman run ... sh -c`, never by the
 * host shell.
 */
function buildInstallScript(registryUrl: string): string {
  return [
    "set -e",
    `cd ${CONTAINER_WORKDIR}`,
    // Force every package fetch through the proxy — the only outbound peer.
    `npm config set registry ${registryUrl}`,
    // Install target deps. --ignore-scripts prevents arbitrary lifecycle code;
    // --registry re-affirms the proxy even if a local .npmrc disagrees.
    `npm install --ignore-scripts --no-audit --no-fund --registry ${registryUrl}`,
    // Also install the PINNED test toolchain (see PINNED_TEST_TOOLCHAIN) NOW,
    // while the proxy is still reachable. The subsequent Test_Execution_Phase
    // (task 9.2) runs with NO network, so Vitest + fast-check must already be on
    // disk by the time that phase starts. The versions are not optional: the
    // result classifier depends on fast-check 3.x's deterministic async
    // failure-message shape, so this is NOT `|| true` — a failure to install the
    // pinned toolchain must surface as an install failure, not silently fall
    // back to whatever (possibly 4.x) version later resolves. --ignore-scripts
    // and --registry keep the same R12.2 discipline as the target-deps install.
    `npm install --ignore-scripts --no-audit --no-fund --save-dev --registry ${registryUrl} ${PINNED_TEST_TOOLCHAIN}`,
  ].join("\n");
}

/**
 * Run the INSTALL container inside an existing {@link InstallTopology}.
 *
 * The install container:
 *  - mounts ONLY `targetRepoPath` (plain bind mount, no `:Z`, macOS-safe), so
 *    file access is confined to that one directory (R12.6);
 *  - is attached to ONLY the internal network, so it has no direct outbound
 *    route — its one reachable peer is the proxy;
 *  - runs `npm install --ignore-scripts --registry <proxy>` so only the package
 *    registry is reachable and lifecycle scripts stay disabled (R12.2).
 *
 * Returns `null` on a successful install. On failure it returns a closed
 * {@link ActualResult}:
 *  - `TIMEOUT` if the install exceeded the phase timeout (the container is
 *    force-removed first);
 *  - `RUNNER_UNAVAILABLE` if the install container could not be created
 *    (`podman run` exit 125) — never a host fallback;
 *  - `EXECUTION_ERROR` if the install itself failed (non-zero, non-125 exit).
 *
 * The install container is always force-removed before returning (success or
 * failure) so it never survives into teardown or the test phase.
 *
 * @param topology the live topology from {@link createInstallTopology}.
 * @param propertyId propagated onto any returned result.
 * @param targetRepoPath the ONE directory mounted into the install container.
 * @param options.installImage install base image (defaults to Node LTS).
 * @param options.timeoutSeconds overall install timeout (default 600s).
 */
export async function runInstallInContainer(
  topology: InstallTopology,
  propertyId: string,
  targetRepoPath: string,
  options: { installImage?: string; timeoutSeconds?: number } = {},
): Promise<Exclude<ActualResult, { outcome: "VERDICT" }> | null> {
  const repoAbs = resolve(targetRepoPath);
  const installImage = options.installImage ?? DEFAULT_INSTALL_IMAGE;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_INSTALL_TIMEOUT_SECONDS;
  const installContainerName = `spec-lantern-install-${topology.runToken}`;

  const script = buildInstallScript(topology.registryUrl);

  // ONLY the target working dir is mounted (plain bind mount, no :Z). The
  // install container sits on ONLY the internal network, so it cannot reach the
  // internet directly — its one peer is the proxy. See the module header for the
  // full macOS mount discipline.
  const podmanArgs = [
    "run",
    "--rm",
    "--name",
    installContainerName,
    "--network",
    topology.networkName,
    "-v",
    `${repoAbs}:${CONTAINER_WORKDIR}`,
    "-w",
    CONTAINER_WORKDIR,
    installImage,
    "sh",
    "-c",
    script,
  ];

  try {
    const proc = await runProcess("podman", podmanArgs, {
      timeoutMs: timeoutSeconds * 1000,
    });

    if (proc.timedOut) {
      return { propertyId, outcome: "TIMEOUT", limitSeconds: timeoutSeconds };
    }

    // `podman run` exiting 125 means the container could not be created — a
    // runner-unavailability, never a host fallback.
    if (proc.code === 125) {
      return {
        propertyId,
        outcome: "RUNNER_UNAVAILABLE",
        reason: `install container could not be created: ${proc.stderr.trim().slice(0, 500)}`,
      };
    }

    if (proc.code !== 0) {
      return {
        propertyId,
        outcome: "EXECUTION_ERROR",
        reason:
          `dependency install failed (podman exit ${String(proc.code)}): ` +
          `${proc.stderr.trim().slice(0, 500)}`,
      };
    }

    // Success — install completed inside the topology.
    return null;
  } finally {
    // Defensive: ensure the install container never survives, even on timeout.
    await runProcess("podman", ["rm", "-f", installContainerName], {
      timeoutMs: CONTROL_TIMEOUT_MS,
    }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Teardown                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Tear down the install-phase topology BEFORE the Test_Execution_Phase begins.
 *
 * Removes the registry-proxy container (force) and then BOTH networks — the
 * internal one and (when the handle has it) the outbound one the proxy was
 * dual-attached to — so no install-phase network or container survives into the
 * no-network test phase (R5.4, R12.3). Robust by design: it force-detaches any
 * lingering containers, retries each `network rm` (rootless Podman can briefly
 * keep a just-freed network pinned), and swallows errors from every step so a
 * partially-created topology is still fully cleaned up and it is safe to call
 * more than once (a missing network/container is not an error).
 *
 * @param topology the topology (or partial handle) to dismantle. `networkName`
 *   and `proxyContainerName` are required; `outboundNetworkName` is optional so
 *   an older handle (or a cleanup before the outbound network was created) is
 *   still accepted.
 */
export async function teardownInstallTopology(
  topology: Pick<InstallTopology, "proxyContainerName" | "networkName"> &
    Partial<Pick<InstallTopology, "outboundNetworkName">>,
): Promise<void> {
  // 1. Remove the proxy container first; a network cannot be removed while a
  //    container is still attached to it. Force-remove so a running/exited
  //    container is reaped either way.
  await runProcess("podman", ["rm", "-f", topology.proxyContainerName], {
    timeoutMs: CONTROL_TIMEOUT_MS,
  }).catch(() => undefined);

  // 2. Remove BOTH networks the topology may have created — the internal one
  //    and (when present) the outbound one the proxy was dual-attached to. Each
  //    goes through the same hardened removal: detach any lingering containers,
  //    then retry `network rm` so a transiently-pinned network is still reaped
  //    (the exact `spec-lantern-*-net-*` leftover this prevents). A handle that
  //    predates the outbound network simply omits it. Order does not matter —
  //    each removal is independent and idempotent.
  await removeNetworkHard(topology.networkName);
  if (topology.outboundNetworkName) {
    await removeNetworkHard(topology.outboundNetworkName);
  }
}

/**
 * Force-remove a single Podman network, robustly. First force-removes any
 * container still attached (which would otherwise block removal and leak the
 * network), then retries `network rm` with a short backoff because in rootless
 * Podman a just-force-removed container can briefly keep a network pinned. Treats
 * "already gone" as success and swallows every error so teardown always resolves
 * (R5.4/R12.3) and is idempotent.
 */
async function removeNetworkHard(networkName: string): Promise<void> {
  // Detach anything still on the network so it cannot block removal.
  const attached = await runProcess(
    "podman",
    [
      "network",
      "inspect",
      networkName,
      "--format",
      "{{range .Containers}}{{.Name}} {{end}}",
    ],
    { timeoutMs: CONTROL_TIMEOUT_MS },
  ).catch(() => undefined);
  if (attached && attached.code === 0) {
    const names = attached.stdout.split(/\s+/).filter((n) => n.length > 0);
    for (const name of names) {
      await runProcess("podman", ["rm", "-f", name], {
        timeoutMs: CONTROL_TIMEOUT_MS,
      }).catch(() => undefined);
    }
  }

  for (let attempt = 0; attempt < NETWORK_RM_MAX_ATTEMPTS; attempt += 1) {
    const rm = await runProcess(
      "podman",
      ["network", "rm", "-f", networkName],
      { timeoutMs: CONTROL_TIMEOUT_MS },
    ).catch(() => undefined);
    // Gone (rm succeeded) — stop. A `code === 0` or a missing-network error
    // both mean the network no longer exists.
    if (!rm || rm.code === 0) break;
    const stderr = rm.stderr.toLowerCase();
    if (stderr.includes("no such network") || stderr.includes("not find")) break;
    // Still pinned — confirm it is actually gone before retrying/giving up.
    if (!(await networkExists(networkName))) break;
    if (attempt < NETWORK_RM_MAX_ATTEMPTS - 1) {
      await delay(NETWORK_RM_BACKOFF_MS);
    }
  }
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** True iff a Podman network with this name currently exists. */
async function networkExists(networkName: string): Promise<boolean> {
  const probe = await runProcess(
    "podman",
    ["network", "exists", networkName],
    { timeoutMs: CONTROL_TIMEOUT_MS },
  ).catch(() => undefined);
  // `podman network exists` exits 0 when present, non-zero when absent.
  return probe?.code === 0;
}

/* -------------------------------------------------------------------------- */
/* Startup reaper — defensive cleanup of a PRIOR hard-killed run              */
/* -------------------------------------------------------------------------- */

/**
 * Reap any leftover install-phase resources a PRIOR run left behind.
 *
 * WHY THIS EXISTS. {@link runInstallPhase} already tears its topology down in a
 * `finally`, and {@link createInstallTopology} reaps a partially-built topology
 * on any failure or throw. But a `finally` cannot run when the client process
 * is KILLED HARD — the observed leak was exactly this: podman hung on a control
 * query, the client was SIGKILLed, and a `spec-lantern-proxy-<token>` container
 * plus its internal + outbound networks were left running with nothing left to
 * reap them. No in-process guard can survive its own SIGKILL, so the only place
 * to recover from it is the NEXT run: {@link createInstallTopology} calls this
 * first, so every run begins by clearing whatever a hard-killed predecessor
 * orphaned.
 *
 * SCOPING (never touches unrelated resources). The reaper lists containers and
 * networks by this runner's own NAME PREFIXES only
 * ({@link PROXY_CONTAINER_PREFIX}, {@link INSTALL_CONTAINER_PREFIX},
 * {@link INSTALL_NETWORK_PREFIX}, {@link OUTBOUND_NETWORK_PREFIX}) and removes
 * ONLY names that still start with one of those prefixes after the listing
 * returns — a belt-and-suspenders check so a loose `--filter` match can never
 * widen the blast radius. It therefore can only ever remove this runner's own
 * per-run install topology, never a user's container or network.
 *
 * VOLUME SAFETY. It removes NO volumes. The persistent Verdaccio cache volume
 * ({@link VERDACCIO_CACHE_VOLUME}) is intentionally kept across runs and is
 * never listed or removed here.
 *
 * NO-THROW / BOUNDED. Every podman call is bounded by the module's
 * {@link CONTROL_TIMEOUT_MS} control-timeout (SIGKILL on the client) and every
 * error is swallowed, so a hung or absent podman makes the reaper return
 * promptly rather than hang — identical discipline to {@link teardownInstallTopology}.
 * It resolves `undefined` in all cases and never throws, so calling it at the
 * start of a run can never make setup fail.
 */
export async function reapLeftoverInstallResources(): Promise<void> {
  // 1. Reap leftover install-phase CONTAINERS (the proxy and any stray install
  //    container) by name prefix. `podman ps -a` lists running AND exited ones
  //    so a hung-then-killed proxy is caught whatever state it is in. The
  //    `--filter name=` is a convenience; the authoritative scoping is the
  //    prefix re-check below.
  const containerPrefixes = [PROXY_CONTAINER_PREFIX, INSTALL_CONTAINER_PREFIX];
  const psArgs = ["ps", "-a", "--format", "{{.Names}}"];
  for (const prefix of containerPrefixes) {
    psArgs.push("--filter", `name=${prefix}`);
  }
  const ps = await runProcess("podman", psArgs, {
    timeoutMs: CONTROL_TIMEOUT_MS,
  }).catch(() => undefined);
  if (ps && ps.code === 0) {
    const names = ps.stdout
      .split(/\r?\n/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      // Belt-and-suspenders: only remove names that still match one of OUR
      // prefixes, so a loose filter match can never reach an unrelated container.
      .filter((n) => containerPrefixes.some((p) => n.startsWith(p)));
    for (const name of names) {
      await runProcess("podman", ["rm", "-f", name], {
        timeoutMs: CONTROL_TIMEOUT_MS,
      }).catch(() => undefined);
    }
  }

  // 2. Reap leftover install-phase NETWORKS (internal + outbound) by name
  //    prefix, each through the hardened removal that detaches any lingering
  //    container and retries the `network rm` (rootless Podman can briefly keep
  //    a just-freed network pinned). No volume is ever listed or removed, so the
  //    persistent Verdaccio cache volume is untouched.
  const networkPrefixes = [INSTALL_NETWORK_PREFIX, OUTBOUND_NETWORK_PREFIX];
  const lsArgs = ["network", "ls", "--format", "{{.Name}}"];
  for (const prefix of networkPrefixes) {
    lsArgs.push("--filter", `name=${prefix}`);
  }
  const ls = await runProcess("podman", lsArgs, {
    timeoutMs: CONTROL_TIMEOUT_MS,
  }).catch(() => undefined);
  if (ls && ls.code === 0) {
    const names = ls.stdout
      .split(/\r?\n/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      // Same belt-and-suspenders prefix re-check as for containers.
      .filter((n) => networkPrefixes.some((p) => n.startsWith(p)));
    for (const name of names) {
      await removeNetworkHard(name);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Orchestration — the clean lifecycle contract task 9.2 sequences after      */
/* -------------------------------------------------------------------------- */

/** Options for {@link runInstallPhase}. */
export interface RunInstallPhaseOptions {
  /** Registry-proxy image (defaults to Verdaccio). */
  proxyImage?: string;
  /** Install base image (defaults to Node LTS). */
  installImage?: string;
  /** Overall install timeout in seconds (default 600). */
  timeoutSeconds?: number;
}

/**
 * The outcome of a full install phase. Exactly one of:
 *  - `{ ok: true }` — the topology was created, the install completed, and the
 *    topology was torn down; the target working directory now holds an
 *    installed `node_modules` and the test phase (task 9.2) may proceed WITH NO
 *    NETWORK.
 *  - `{ ok: false; result }` — the phase did not complete; `result` is the
 *    closed {@link ActualResult} describing why (RUNNER_UNAVAILABLE / TIMEOUT /
 *    EXECUTION_ERROR). The topology has already been torn down.
 */
export type InstallPhaseOutcome =
  | { ok: true }
  | { ok: false; result: Exclude<ActualResult, { outcome: "VERDICT" }> };

/**
 * Run the complete Dependency_Install_Phase and ALWAYS tear the topology down.
 *
 * This is the clean lifecycle seam the Test_Execution_Phase (task 9.2) sequences
 * AFTER: it creates the install topology, runs the install inside it, and — in a
 * `finally` — tears the topology (proxy + internal network) down so the test
 * phase starts from a no-network baseline (R5.4, R12.3). Teardown runs even when
 * the install fails or throws, so no stray network/container survives.
 *
 * It NEVER runs Target_Repo code on the host: the install happens only via
 * `podman run`, and a Podman-unavailability surfaces as a `RUNNER_UNAVAILABLE`
 * outcome rather than a host fallback.
 *
 * @param propertyId propagated onto any non-ok {@link ActualResult}.
 * @param targetRepoPath the ONE directory mounted into the install container.
 * @param options proxy/install images and the install timeout.
 */
export async function runInstallPhase(
  propertyId: string,
  targetRepoPath: string,
  options: RunInstallPhaseOptions = {},
): Promise<InstallPhaseOutcome> {
  const topology = await createInstallTopology(propertyId, {
    proxyImage: options.proxyImage,
  });

  // createInstallTopology returns a RUNNER_UNAVAILABLE ActualResult (not a
  // handle) when it could not stand the topology up. Discriminate on `outcome`.
  if ("outcome" in topology) {
    return { ok: false, result: topology };
  }

  try {
    const installFailure = await runInstallInContainer(
      topology,
      propertyId,
      targetRepoPath,
      {
        installImage: options.installImage,
        timeoutSeconds: options.timeoutSeconds,
      },
    );
    if (installFailure !== null) {
      return { ok: false, result: installFailure };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      result: {
        propertyId,
        outcome: "EXECUTION_ERROR",
        reason: `install phase orchestration failed: ${message}`,
      },
    };
  } finally {
    // Always dismantle the install topology before the test phase begins.
    await teardownInstallTopology(topology);
  }
}
