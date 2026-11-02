/**
 * The no-network Test_Execution_Phase (task 9.2).
 *
 * This module is the second half of the runner's two-phase lifecycle (design
 * "Two-Phase Execution Lifecycle"). It runs the Correctness_Property test
 * file(s) inside a rootless Podman container with ALL network access DISABLED
 * for the ENTIRE phase — `podman run --network none`, so the container has no
 * network namespace access at all, inbound or outbound, from phase start until
 * process termination (R12.3). Because dependencies were already fetched during
 * the Dependency_Install_Phase (task 9.1, {@link ./install-phase.ts}) through
 * the registry proxy, the test phase needs no network: it runs Vitest against
 * the `node_modules` the install phase already populated.
 *
 * PHASE ORDERING (R5.4). {@link runTwoPhase} composes the two phases in the only
 * order the design permits: it runs {@link runInstallPhase} FIRST and only
 * starts the no-network test container when the install phase reports
 * `{ ok: true }` (the topology was created, the install succeeded, and the
 * install topology — the internal network + proxy — was torn down). If the
 * install phase returns `{ ok: false }`, its closed non-VERDICT
 * {@link ActualResult} (RUNNER_UNAVAILABLE / TIMEOUT / EXECUTION_ERROR) is
 * surfaced unchanged and the test phase NEVER runs. This keeps the install→test
 * sequencing honest: the test container cannot start before the install has
 * fully completed and its network has been dismantled.
 *
 * WHY `--network none`. The install phase enforces "registry only" by the SHAPE
 * of an internal-only network plus a single outbound-capable proxy (rootless
 * Podman cannot natively allowlist outbound domains). The test phase needs the
 * opposite — NOTHING reachable — and that IS natively expressible: `--network
 * none` gives the container its own empty network namespace with only a loopback
 * interface and no route anywhere. There is no bridge, no proxy, no DNS; a
 * property that tries to fetch over the network simply cannot. This is strictly
 * stronger than relying on the install topology having been torn down, and it
 * holds for the whole phase because the flag is set at `podman run` time and the
 * namespace lives for the container's entire lifetime.
 *
 * HOST-SAFETY INVARIANTS (identical discipline to {@link ./install-phase.ts},
 * see steering 00-pipeline-and-safety.md):
 *  1. No host execution — Vitest runs ONLY via `podman run`, never in the host
 *     shell. There is no code path here that runs the Target_Repo's tests on the
 *     host.
 *  2. No host fallback — if Podman is absent or the test container cannot be
 *     created, this module surfaces a `RUNNER_UNAVAILABLE` {@link ActualResult}
 *     and stops; it never degrades to running tests on the host.
 *  3. Boundary confinement (R12.6) — the test container mounts ONLY the one
 *     target working directory it was handed; file access is confined to that
 *     mount.
 *  4. Closed outcomes — the resolved value is always one of the `ActualResult`
 *     shapes. Timeouts and execution errors are their own outcomes, never
 *     encoded as PASS/FAIL. Classification is delegated to the SHARED
 *     {@link ./vitest-classify.ts} helper so the test phase classifies
 *     identically to the walking-skeleton runner.
 *
 * macOS MOUNT DISCIPLINE (hard constraints, carried over verbatim from the
 * other runner modules):
 *  - The target directory is bound with a PLAIN bind mount. No `:Z` SELinux
 *    relabel — macOS is not an SELinux host and relabeling a broad shared path
 *    is wrong there.
 *  - Only the specific target working directory is mounted. Never `$HOME`, never
 *    any other broad path.
 *  - Nothing the container must see is placed under host `/tmp`. The macOS
 *    Podman machine shares `/Users` but NOT the host `/tmp`, so every path the
 *    test container reads or writes (the property test file run in place inside
 *    the mount, and the Vitest result JSON) lives UNDER THE MOUNTED REPO (under
 *    `/Users`), visible in the VM.
 *
 * SCOPE. This task builds the no-network test phase and the two-phase
 * composition seam the execution orchestrator / `execute_properties` tool
 * (task 10) calls. Execution_Context pinning across the boundary (task 10.3),
 * the Safety Gate dispatch (task 8.1), and the Comparison Engine (task 14) are
 * deliberately NOT here; the clean {@link runTwoPhase} / {@link runTestPhase}
 * entry points are the seam those later tasks build on.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ActualResult, ExecutionContext } from "@spec-lantern/types";
import {
  runInstallPhase,
  type RunInstallPhaseOptions,
} from "./install-phase.js";
import { parseVitestJson } from "./vitest-classify.js";

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/** Default per-run execution timeout in seconds (R5.7). */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** Default container base image (Node LTS with npm available). */
const DEFAULT_IMAGE = "docker.io/library/node:20-bookworm-slim";

/** Where the target repo working directory is mounted inside the container. */
const CONTAINER_WORKDIR = "/work";

/** Name of the Vitest JSON report file written inside the mount. */
const RESULT_FILE = ".spec-lantern-result.json";

/* -------------------------------------------------------------------------- */
/* Request shape                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A request to run exactly one Correctness_Property through the two-phase
 * lifecycle (install, then the no-network test phase).
 *
 * It is intentionally shaped like the walking-skeleton runner's request so the
 * orchestrator (task 10) can build one request for either runner. The fields
 * that carry the boundary-confinement invariant (R12.6):
 *  - `targetRepoPath` is the ONE directory mounted into BOTH the install
 *    container (task 9.1) and the no-network test container. The install phase
 *    populates its `node_modules`; the test phase then runs against that.
 *  - `propertyTestFile` is resolved to a path inside that mount (run in place
 *    when already under `targetRepoPath`, otherwise staged into the mount) so it
 *    is reachable only from within the boundary and never executes on the host.
 */
export interface TestPhaseRequest {
  /** The property this run evaluates (propagated onto the ActualResult). */
  propertyId: string;
  /**
   * Absolute path to the target repo working directory. This — and only this —
   * directory is mounted into the container (R12.6 boundary confinement). It is
   * the SAME directory the install phase installed into.
   */
  targetRepoPath: string;
  /**
   * The single Correctness_Property test file to execute. Either a path already
   * inside `targetRepoPath` (run in place) or an absolute path outside the repo
   * (staged into the mount before the run). The file never executes on the host.
   */
  propertyTestFile: string;
  /**
   * Execution_Context pinned for this run. Defaults are generated when omitted
   * (a random seed, UTC, and a fixed instant). Full propagation through
   * fast-check/the clock is task 10.3; here it is recorded and attached to any
   * Counterexample so the result is self-describing.
   */
  executionContext?: ExecutionContext;
  /**
   * Per-run execution timeout in seconds. Default 30 (R5.7). Exceeding it
   * terminates the container and yields a TIMEOUT outcome (never PASS/FAIL).
   */
  timeoutSeconds?: number;
  /**
   * Container image that provides Node + a package manager. Defaults to a
   * current Node LTS image. Must match the install image so the pinned toolchain
   * the install phase placed in `node_modules` resolves identically.
   */
  image?: string;
}

/**
 * Options for {@link runTwoPhase}: the {@link TestPhaseRequest} plus the
 * install-phase knobs ({@link RunInstallPhaseOptions}) forwarded to
 * {@link runInstallPhase} for phase one.
 */
export interface TwoPhaseRequest extends TestPhaseRequest {
  /**
   * Options forwarded to the Dependency_Install_Phase (proxy/install images and
   * the install timeout). The install phase runs FIRST and must complete before
   * the no-network test phase begins.
   */
  install?: RunInstallPhaseOptions;
}

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
 * only use this for `podman` itself. An optional timeout kills the podman
 * client; the container is reaped separately by the caller's `podman rm -f` so
 * no stray container survives a timeout.
 *
 * Mirrors the identical helper in the sibling runner modules deliberately: all
 * three share the same spawn/timeout/no-host-execution discipline, and the few
 * duplicated lines keep each runner module self-contained around the one
 * external binary it shells out to.
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
 * Identical probe to the sibling runners' so the no-host-fallback guarantee is
 * uniform across all three runner modules.
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
/* Execution_Context + test-file resolution                                   */
/* -------------------------------------------------------------------------- */

/** Build the default Execution_Context when the caller did not pin one. */
function defaultExecutionContext(): ExecutionContext {
  const randomSeed = randomBytes(4).readUInt32BE(0);
  return {
    randomSeed,
    timezone: "UTC",
    fixedCurrentTime: "2025-01-01T00:00:00.000Z",
  };
}

/**
 * Determine the path, relative to the mounted working directory, at which the
 * property test file will be visible inside the container. If the file already
 * lives inside the target repo it is used in place; otherwise it is staged into
 * the mount so it is reachable from within the boundary (and only there).
 *
 * Returns the in-container absolute path plus a cleanup callback for any staged
 * copy. Mirrors the skeleton runner's resolution so a property authored for one
 * runner runs identically under the other.
 */
async function resolveTestFileInMount(
  targetRepoPath: string,
  propertyTestFile: string,
): Promise<{ inContainerPath: string; cleanup: () => Promise<void> }> {
  const repoAbs = resolve(targetRepoPath);
  const fileAbs = isAbsolute(propertyTestFile)
    ? propertyTestFile
    : resolve(repoAbs, propertyTestFile);

  const rel = relative(repoAbs, fileAbs);
  const insideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);

  if (insideRepo) {
    const posixRel = rel.split(sep).join("/");
    return {
      inContainerPath: `${CONTAINER_WORKDIR}/${posixRel}`,
      cleanup: async () => {
        /* nothing staged */
      },
    };
  }

  // Stage the external file into a temp dir INSIDE the mounted working dir so it
  // is visible in the container yet still confined to the runner boundary.
  const stageDirHost = await mkdtemp(join(repoAbs, ".spec-lantern-prop-"));
  const stagedName = basename(fileAbs);
  const stagedHostPath = join(stageDirHost, stagedName);
  await copyFile(fileAbs, stagedHostPath);

  const stageRel = relative(repoAbs, stagedHostPath).split(sep).join("/");
  return {
    inContainerPath: `${CONTAINER_WORKDIR}/${stageRel}`,
    cleanup: async () => {
      await rm(stageDirHost, { recursive: true, force: true });
    },
  };
}

/**
 * Compose the shell script that runs ENTIRELY INSIDE the no-network test
 * container: run exactly the one property test file through Vitest, writing the
 * JSON report to a known path inside the mount.
 *
 * Crucially this script performs NO network operation. The install phase already
 * populated `node_modules` (including the PINNED_TEST_TOOLCHAIN) through the
 * registry proxy, so the test phase runs against what is already on disk. We DO
 * NOT run `npm install` here — there is no network to install from, and
 * attempting to would (correctly) fail. `npx --no-install` is used so `npx`
 * never tries to fetch Vitest from a registry; it resolves the locally installed
 * binary or fails loudly (surfacing as an EXECUTION_ERROR via the classifier)
 * rather than silently reaching for the network that isn't there.
 *
 * Executed by the container's shell via `podman run ... sh -c`, never by the
 * host shell.
 */
function buildTestScript(inContainerTestPath: string, ctx: ExecutionContext): string {
  return [
    "set -e",
    `export TZ='${ctx.timezone}'`,
    `cd ${CONTAINER_WORKDIR}`,
    // Run exactly one file against the ALREADY-INSTALLED deps. --no-install keeps
    // npx from reaching for a registry (there is no network in this phase); it
    // uses the locally installed Vitest the install phase placed in node_modules.
    `npx --no-install vitest run ${inContainerTestPath} --reporter=json --outputFile=${CONTAINER_WORKDIR}/${RESULT_FILE} --no-color`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* The no-network test phase                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run the Test_Execution_Phase for ONE property inside a rootless Podman
 * container with NO NETWORK (`--network none`) and return its
 * {@link ActualResult}.
 *
 * Preconditions. The target working directory MUST already have its
 * dependencies installed (the Dependency_Install_Phase ran first — see
 * {@link runTwoPhase}). This function performs no install and has no network, so
 * a missing `node_modules` surfaces as an honest EXECUTION_ERROR from the
 * classifier rather than a silent network fetch.
 *
 * Guarantees:
 *  - The container runs with `--network none`: no network namespace access at
 *    all, inbound or outbound, for the entire phase (R12.3).
 *  - If Podman is unavailable or the container cannot be created, returns
 *    RUNNER_UNAVAILABLE and NEVER runs the target on the host (R5.8, R12.5).
 *  - The container mounts ONLY `targetRepoPath` (R12.6); Vitest runs inside it.
 *  - The result is one of the closed {@link ActualResult} shapes. Timeouts and
 *    execution errors are their own outcomes, never PASS/FAIL. Classification is
 *    delegated to the shared {@link parseVitestJson} so it matches the skeleton
 *    runner exactly.
 *
 * @param request the property, the single working directory to mount, and the
 *   per-run execution context/limits.
 */
export async function runTestPhase(
  request: TestPhaseRequest,
): Promise<ActualResult> {
  const {
    propertyId,
    targetRepoPath,
    propertyTestFile,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    image = DEFAULT_IMAGE,
  } = request;
  const ctx = request.executionContext ?? defaultExecutionContext();

  // 1. Guard: Podman must be present AND the engine reachable. No host fallback.
  const unavailableReason = await detectPodmanUnavailable();
  if (unavailableReason) {
    return { propertyId, outcome: "RUNNER_UNAVAILABLE", reason: unavailableReason };
  }

  const repoAbs = resolve(targetRepoPath);
  const containerName = `spec-lantern-test-${createHash("sha1")
    .update(`${propertyId}:${Date.now()}:${randomBytes(4).toString("hex")}`)
    .digest("hex")
    .slice(0, 16)}`;

  let staged: { inContainerPath: string; cleanup: () => Promise<void> } | undefined;

  try {
    staged = await resolveTestFileInMount(repoAbs, propertyTestFile);
    const script = buildTestScript(staged.inContainerPath, ctx);

    // 2. Run inside the container with NO NETWORK. `--network none` gives the
    //    container an empty network namespace (loopback only, no route out), so
    //    all inbound/outbound access is disabled for the whole phase (R12.3).
    //    ONLY the target working dir is mounted with a PLAIN bind mount — never a
    //    home directory or other broad path, and no `:Z` relabel (macOS is not
    //    SELinux-labeled). Everything the container reads/writes lives under the
    //    mount (under `/Users`), visible in the Podman VM.
    const podmanArgs = [
      "run",
      "--rm",
      "--network",
      "none",
      "--name",
      containerName,
      "-v",
      `${repoAbs}:${CONTAINER_WORKDIR}`,
      "-w",
      CONTAINER_WORKDIR,
      image,
      "sh",
      "-c",
      script,
    ];

    const proc = await runProcess("podman", podmanArgs, {
      timeoutMs: timeoutSeconds * 1000,
    });

    // 3. Timeout: terminate the container and report TIMEOUT (never PASS/FAIL).
    if (proc.timedOut) {
      await runProcess("podman", ["rm", "-f", containerName], { timeoutMs: 15_000 });
      return { propertyId, outcome: "TIMEOUT", limitSeconds: timeoutSeconds };
    }

    // 4. `podman run` exiting 125 means the container could not be created — a
    //    runner-unavailability, never a host fallback.
    if (proc.code === 125) {
      return {
        propertyId,
        outcome: "RUNNER_UNAVAILABLE",
        reason: `test container could not be created: ${proc.stderr.trim().slice(0, 500)}`,
      };
    }

    // 5. Read the Vitest JSON report back from the mounted dir (host view of the
    //    same files the container wrote). Reading a file is not executing code.
    const reportHostPath = join(repoAbs, RESULT_FILE);
    let reportRaw = "";
    try {
      reportRaw = await readFile(reportHostPath, "utf8");
    } catch {
      // No report written — classify from exit code/stderr as an execution
      // error (e.g. node_modules absent so `npx --no-install` could not find
      // Vitest). Never a verdict.
      return {
        propertyId,
        outcome: "EXECUTION_ERROR",
        reason:
          `Vitest produced no JSON report (podman exit ${String(proc.code)}): ` +
          `${proc.stderr.trim().slice(0, 500)}`,
      };
    } finally {
      await rm(reportHostPath, { force: true }).catch(() => undefined);
    }

    // 6. Classify with the SHARED helper so the test phase matches the skeleton
    //    runner exactly. A Vitest-reported per-test/hook timeout carries a
    //    sentinel limitSeconds=0 from the classifier; rewrite it with the per-run
    //    limit actually in effect so the TIMEOUT reports the real limit.
    const classified = parseVitestJson(propertyId, reportRaw, proc.stderr, ctx);
    if (classified.outcome === "TIMEOUT") {
      return { ...classified, limitSeconds: timeoutSeconds };
    }
    return classified;
  } catch (err) {
    // Any orchestration failure is an execution error — never a silent host run.
    const message = err instanceof Error ? err.message : String(err);
    return {
      propertyId,
      outcome: "EXECUTION_ERROR",
      reason: `test phase orchestration failed: ${message}`,
    };
  } finally {
    if (staged) await staged.cleanup().catch(() => undefined);
    // Defensive: ensure no stray container survives.
    await runProcess("podman", ["rm", "-f", containerName], {
      timeoutMs: 15_000,
    }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Two-phase composition — install first, THEN the no-network test phase      */
/* -------------------------------------------------------------------------- */

/**
 * Run the complete two-phase lifecycle for ONE property: the
 * Dependency_Install_Phase FIRST, then — only on install success — the
 * no-network Test_Execution_Phase.
 *
 * This is the clean entry point the execution orchestrator / `execute_properties`
 * tool (task 10) calls. It enforces the phase ordering the design requires
 * (R5.4): the install phase ({@link runInstallPhase}) must create its topology,
 * complete the install, AND tear that topology down before the test container
 * starts. The install phase's own `finally` dismantles the internal network +
 * proxy, so by the time this function reaches the test phase there is no
 * install-phase network left — and the test container then runs with
 * `--network none` on top of that (R12.3), a belt-and-suspenders no-network
 * guarantee.
 *
 * Short-circuit on install failure. If {@link runInstallPhase} returns
 * `{ ok: false }`, this surfaces its closed non-VERDICT {@link ActualResult}
 * (RUNNER_UNAVAILABLE / TIMEOUT / EXECUTION_ERROR) UNCHANGED and the test phase
 * NEVER runs. A property can only reach the test phase after a successful
 * install, so the install→test ordering can never be observed out of order.
 *
 * Host-safety is preserved end to end: both phases run Target_Repo code only via
 * `podman run`, and a Podman-unavailability in either phase surfaces as
 * RUNNER_UNAVAILABLE rather than a host fallback.
 *
 * @param request the property, the single working directory to mount (shared by
 *   both phases), the per-run execution context/limits, and optional
 *   install-phase options.
 */
export async function runTwoPhase(
  request: TwoPhaseRequest,
): Promise<ActualResult> {
  const { propertyId, targetRepoPath } = request;

  // PHASE ONE: install dependencies through the registry-proxy topology, then
  // tear that topology down (runInstallPhase always does so in a finally). The
  // test phase MUST NOT begin until this completes (R5.4).
  const install = await runInstallPhase(
    propertyId,
    targetRepoPath,
    request.install ?? {},
  );

  // Install did not complete — surface its closed non-VERDICT result and DO NOT
  // run the test phase. The ordering guarantee: no test container is ever
  // created unless the install fully succeeded first.
  if (!install.ok) {
    return install.result;
  }

  // PHASE TWO: now that the install is done and its network is gone, run the
  // property with NO NETWORK at all.
  return runTestPhase({
    propertyId,
    targetRepoPath,
    propertyTestFile: request.propertyTestFile,
    executionContext: request.executionContext,
    timeoutSeconds: request.timeoutSeconds,
    image: request.image,
  });
}
