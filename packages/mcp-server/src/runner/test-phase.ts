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
 * SCOPE. This module builds the no-network test phase and the two-phase
 * composition seam the execution orchestrator / `execute_properties` tool
 * (task 10) calls. The Safety Gate dispatch (task 8.1) and the Comparison
 * Engine (task 14) are deliberately NOT here; the clean {@link runTwoPhase} /
 * {@link runTestPhase} entry points are the seam those later tasks build on.
 *
 * EXECUTION_CONTEXT RECORDING (task 10.3). This module now OWNS the
 * per-execution Execution_Context: it CHOOSES/records a Random_Seed, pins the
 * timezone and the Fixed_Current_Time, and makes the run deterministic by
 * threading all three INTO the container (see {@link buildExecutionContextEnv}
 * and {@link buildSeedClockSetupModule}) — fast-check is seeded from the
 * recorded Random_Seed via `fc.configureGlobal`, and `TZ` is pinned for the
 * whole phase. The recorded context is then returned ALONGSIDE the
 * {@link ActualResult} (the {@link runTestPhaseWithContext} /
 * {@link runTwoPhaseWithContext} variants) so the orchestrator can surface it
 * for EVERY execution (R6.1), not only on FAIL. The shared Vitest classifier
 * still attaches the SAME context onto a FAIL Counterexample
 * (`counterexample.executionContext`, R6.2). This module does NOT change the
 * outcome CLASSIFICATION (VERDICT vs TIMEOUT vs EXECUTION_ERROR) — that is
 * owned by {@link ./vitest-classify.ts}; 10.3's edits are confined to seeding
 * and context recording.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_LIMITS,
  type ActualResult,
  type ExecutionContext,
} from "@spec-lantern/types";
import {
  runInstallPhase,
  type RunInstallPhaseOptions,
} from "./install-phase.js";
import {
  SEED_CONFIG_FILE,
  SEED_SETUP_FILE,
  buildExecutionContextEnv,
  buildSeedClockSetupModule,
  buildSeedClockVitestConfig,
  recordExecutionContext,
} from "./execution-context.js";
import {
  applyTimeoutLimit,
  domEnvironmentHint,
  parseVitestJson,
} from "./vitest-classify.js";
import { propertyFileNeedsDom } from "./dom-detect.js";

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Default per-run execution timeout in seconds (R5.7). Sourced from the shared
 * {@link DEFAULT_LIMITS} configuration rather than a bespoke literal, so the
 * TIMEOUT outcome always carries the limit actually in effect (the configured
 * default when the caller did not override `timeoutSeconds`) — never a
 * copy-of-30 that could silently drift from the canonical config.
 */
const DEFAULT_TIMEOUT_SECONDS = DEFAULT_LIMITS.executionTimeoutSeconds;

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
   * Execution_Context pinned for this run. When omitted, one is RECORDED for
   * the execution (task 10.3): a chosen Random_Seed, UTC, and a fixed instant.
   * Whichever context is used is threaded INTO the container — fast-check is
   * seeded from its Random_Seed and `TZ` is pinned from its timezone (see
   * {@link ./execution-context.ts}) — and returned back OUT via the
   * `*WithContext` variants so it is surfaced for EVERY execution (R6.1) and
   * attached to any FAIL Counterexample (R6.2). Supplying a full context is how
   * replay (task 11, R6.3) re-runs a property under the exact recorded values.
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
  // The generated spec-lantern config lives at the mount root; it merges the
  // target's own config and adds the seed/clock setup module + pinned TZ so the
  // run is seeded from the recorded Random_Seed and zone-stable (task 10.3).
  const configPath = `${CONTAINER_WORKDIR}/${SEED_CONFIG_FILE}`;
  return [
    "set -e",
    // Pin the timezone for the WHOLE phase (the setup module re-asserts it
    // defensively too). This is the recorded Execution_Context's timezone.
    `export TZ='${ctx.timezone}'`,
    `cd ${CONTAINER_WORKDIR}`,
    // Run exactly one file against the ALREADY-INSTALLED deps. --no-install keeps
    // npx from reaching for a registry (there is no network in this phase); it
    // uses the locally installed Vitest the install phase placed in node_modules.
    // `-c` points at the generated config that seeds fast-check from the recorded
    // Random_Seed (via the setup module) while preserving the target's own config.
    `npx --no-install vitest run ${inContainerTestPath} -c ${configPath} --reporter=json --outputFile=${CONTAINER_WORKDIR}/${RESULT_FILE} --no-color`,
  ].join("\n");
}

/**
 * Write the seed/clock setup module and the generated merge-config into the
 * mounted working directory so the in-container Vitest loads them. Both live
 * UNDER the single mounted dir (under `/Users` on macOS, visible in the VM) and
 * are dotfile-scoped to spec-lantern so they never collide with the target's
 * own files. Returns a cleanup that removes both so nothing leaks between runs.
 *
 * The generated config MERGES the target's own config (resolved from the
 * conventional config filenames inside the mount) so the target's aliases /
 * jsdom environment survive; spec-lantern only adds the setup module + the
 * pinned TZ. See {@link ./execution-context.ts} for the seeding mechanism.
 */
async function stageSeedClockConfig(
  repoAbs: string,
  timezone: string,
  options: {
    /**
     * POSIX-relative path (inside the mount) to the ONE staged property test
     * file this run executes, so the generated config parses it with the `tsx`
     * loader (JSX in a `.test.ts` property) and can auto-select jsdom for it.
     */
    propertyTestFileRel?: string;
    /**
     * When `true`, default the generated config's `test.environment` to
     * `jsdom` (the property imports react-dom / @testing-library/* / a .tsx
     * module and set no environment pragma). A per-file pragma still overrides.
     */
    autoJsdom?: boolean;
  } = {},
): Promise<() => Promise<void>> {
  const setupHostPath = join(repoAbs, SEED_SETUP_FILE);
  const configHostPath = join(repoAbs, SEED_CONFIG_FILE);

  await writeFile(setupHostPath, buildSeedClockSetupModule());

  // Probe the target's conventional config filenames and resolve the ONE that
  // actually exists on disk. The generated merge-config STATICALLY imports it
  // (so a .ts base config loads through Vite rather than escaping to Node, which
  // cannot import raw .ts and would silently drop the target's aliases). Order
  // mirrors Vitest's own discovery preference; a target with none yields null
  // (an empty base), which is still a valid, alias-free run.
  const candidateNames = [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
  ];
  let baseConfigModule: string | null = null;
  for (const name of candidateNames) {
    try {
      await access(join(repoAbs, name));
      baseConfigModule = `./${name}`;
      break;
    } catch {
      // Not present — try the next conventional name.
    }
  }

  await writeFile(
    configHostPath,
    buildSeedClockVitestConfig({
      // Setup module path relative to the mount root (the config sits there too).
      setupModuleRel: `./${SEED_SETUP_FILE}`,
      // The single base config the target actually has (statically imported), or
      // null when it has none.
      baseConfigModule,
      timezone,
      // Parse the staged property file as tsx (JSX in a .test.ts property) and,
      // when it touches the DOM with no pragma, default its environment to jsdom.
      propertyTestFileRel: options.propertyTestFileRel,
      autoJsdom: options.autoJsdom,
    }),
  );

  return async () => {
    await rm(setupHostPath, { force: true }).catch(() => undefined);
    await rm(configHostPath, { force: true }).catch(() => undefined);
  };
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
  // Back-compat entry point: run the phase and discard the returned context.
  // Callers that need the per-execution context (the orchestrator, task 10.3)
  // use {@link runTestPhaseWithContext} instead.
  const { result } = await runTestPhaseWithContext(request);
  return result;
}

/**
 * The outcome of a context-recording execution: the closed
 * {@link ActualResult} plus the {@link ExecutionContext} that was RECORDED and
 * used to drive the run (R6.1). The two are returned together so the
 * orchestrator can surface the context for EVERY execution — PASS, FAIL,
 * TIMEOUT, or ERROR — not only when a FAIL Counterexample happens to carry it.
 */
export interface ExecutionWithContext {
  result: ActualResult;
  executionContext: ExecutionContext;
}

/**
 * Run the Test_Execution_Phase for ONE property and return BOTH its
 * {@link ActualResult} and the {@link ExecutionContext} recorded for the run
 * (task 10.3). This is the context-aware core; {@link runTestPhase} is the thin
 * back-compat wrapper that discards the context.
 *
 * Recording + determinism (R6.1): a context is RECORDED up front (chosen
 * Random_Seed + pinned timezone + Fixed_Current_Time, or the caller's pinned
 * context for replay) and then threaded INTO the container — the recorded
 * Random_Seed seeds fast-check and the timezone pins `TZ` (see
 * {@link ./execution-context.ts}) — so the recorded values actually drive the
 * run and are not merely cosmetic. The SAME context object is handed to the
 * shared classifier, which attaches it to a FAIL Counterexample (R6.2), and is
 * returned here so the orchestrator surfaces it per-property (R6.1).
 */
export async function runTestPhaseWithContext(
  request: TestPhaseRequest,
): Promise<ExecutionWithContext> {
  const {
    propertyId,
    targetRepoPath,
    propertyTestFile,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    image = DEFAULT_IMAGE,
  } = request;
  // RECORD the Execution_Context for this execution (R6.1). Recorded before the
  // run and used both to drive it (seed + clock) and to describe it (returned /
  // attached), so what ran and what is recorded can never diverge.
  const ctx = recordExecutionContext(request.executionContext);

  // 1. Guard: Podman must be present AND the engine reachable. No host fallback.
  const unavailableReason = await detectPodmanUnavailable();
  if (unavailableReason) {
    return {
      result: { propertyId, outcome: "RUNNER_UNAVAILABLE", reason: unavailableReason },
      executionContext: ctx,
    };
  }

  const repoAbs = resolve(targetRepoPath);
  const containerName = `spec-lantern-test-${createHash("sha1")
    .update(`${propertyId}:${Date.now()}:${randomBytes(4).toString("hex")}`)
    .digest("hex")
    .slice(0, 16)}`;

  let staged: { inContainerPath: string; cleanup: () => Promise<void> } | undefined;
  let cleanupSeedConfig: (() => Promise<void>) | undefined;

  try {
    staged = await resolveTestFileInMount(repoAbs, propertyTestFile);

    // The staged property file's path RELATIVE to the mount root (POSIX). The
    // generated config uses it to parse that one file with the `tsx` loader (so
    // JSX in a `.test.ts` property loads) and to scope the auto-jsdom default.
    const propertyTestFileRel = staged.inContainerPath.startsWith(
      `${CONTAINER_WORKDIR}/`,
    )
      ? staged.inContainerPath.slice(CONTAINER_WORKDIR.length + 1)
      : undefined;

    // Scan the property file's source for DOM imports (react-dom,
    // @testing-library/*, a .tsx import). When present AND the file set no
    // `// @vitest-environment` pragma, default the run to jsdom automatically so
    // a forgotten pragma does not crash with "document is not defined". Reading
    // the file is not executing it. A read failure is non-fatal — we simply do
    // not auto-select jsdom and fall back to the runtime DOM hint.
    let autoJsdom = false;
    if (propertyTestFileRel !== undefined) {
      try {
        const propertySource = await readFile(
          join(repoAbs, propertyTestFileRel),
          "utf8",
        );
        autoJsdom = propertyFileNeedsDom(propertySource);
      } catch {
        autoJsdom = false;
      }
    }

    // Stage the seed/clock setup module + merge-config into the mount so the
    // in-container Vitest seeds fast-check from the recorded Random_Seed and
    // pins TZ (task 10.3), merging the target's own config. Also parses the
    // staged property file as tsx and (when it touches the DOM) defaults to jsdom.
    cleanupSeedConfig = await stageSeedClockConfig(repoAbs, ctx.timezone, {
      propertyTestFileRel,
      autoJsdom,
    });
    const script = buildTestScript(staged.inContainerPath, ctx);

    // Environment carrying the recorded Execution_Context into the container:
    // TZ + the seed + the Fixed_Current_Time. `-e KEY=VALUE` per entry.
    const ctxEnvArgs = Object.entries(buildExecutionContextEnv(ctx)).flatMap(
      ([key, value]) => ["-e", `${key}=${value}`],
    );

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
      ...ctxEnvArgs,
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
      return {
        result: { propertyId, outcome: "TIMEOUT", limitSeconds: timeoutSeconds },
        executionContext: ctx,
      };
    }

    // 4. `podman run` exiting 125 means the container could not be created — a
    //    runner-unavailability, never a host fallback.
    if (proc.code === 125) {
      return {
        result: {
          propertyId,
          outcome: "RUNNER_UNAVAILABLE",
          reason: `test container could not be created: ${proc.stderr.trim().slice(0, 500)}`,
        },
        executionContext: ctx,
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
      // Vitest). Never a verdict. When the crash was a missing DOM global
      // (a component_rendered property that forgot the jsdom pragma), surface
      // the SAME actionable guidance the report-based classifier gives rather
      // than a raw ReferenceError dump.
      const domHint = domEnvironmentHint(proc.stderr);
      return {
        result: {
          propertyId,
          outcome: "EXECUTION_ERROR",
          reason:
            domHint ??
            `Vitest produced no JSON report (podman exit ${String(proc.code)}): ` +
              `${proc.stderr.trim().slice(0, 500)}`,
        },
        executionContext: ctx,
      };
    } finally {
      await rm(reportHostPath, { force: true }).catch(() => undefined);
    }

    // 6. Classify with the SHARED helper so the test phase matches the skeleton
    //    runner exactly. The SAME recorded `ctx` is handed to the classifier so
    //    a FAIL Counterexample carries exactly the context this run used (R6.2).
    //    A Vitest-reported per-test/hook timeout carries a sentinel
    //    limitSeconds=0 from the classifier; stamp it with the per-run limit
    //    actually in effect (via applyTimeoutLimit, a no-op for every non-TIMEOUT
    //    outcome) so the TIMEOUT reports the real configured limit, never the
    //    sentinel or a hard-coded literal.
    const classified = parseVitestJson(propertyId, reportRaw, proc.stderr, ctx);
    return {
      result: applyTimeoutLimit(classified, timeoutSeconds),
      executionContext: ctx,
    };
  } catch (err) {
    // Any orchestration failure is an execution error — never a silent host run.
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: {
        propertyId,
        outcome: "EXECUTION_ERROR",
        reason: `test phase orchestration failed: ${message}`,
      },
      executionContext: ctx,
    };
  } finally {
    if (staged) await staged.cleanup().catch(() => undefined);
    if (cleanupSeedConfig) await cleanupSeedConfig().catch(() => undefined);
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
  // Back-compat entry point: run both phases and discard the recorded context.
  const { result } = await runTwoPhaseWithContext(request);
  return result;
}

/**
 * Run the complete two-phase lifecycle for ONE property and return BOTH its
 * {@link ActualResult} and the {@link ExecutionContext} recorded for the run
 * (task 10.3). This is the context-aware core the orchestrator dispatches
 * through; {@link runTwoPhase} is the thin back-compat wrapper that discards
 * the context.
 *
 * A context is RECORDED for EVERY execution (R6.1) — including one that cannot
 * reach the test phase because the install phase short-circuited. On install
 * failure the install phase's closed non-VERDICT result is surfaced UNCHANGED
 * (classification is untouched) but still paired with the recorded context so
 * the orchestrator can surface a context for every property. On install success
 * the recorded context is threaded into {@link runTestPhaseWithContext}, which
 * seeds fast-check and pins the clock from it and returns the same context it
 * used.
 */
export async function runTwoPhaseWithContext(
  request: TwoPhaseRequest,
): Promise<ExecutionWithContext> {
  const { propertyId, targetRepoPath } = request;

  // RECORD the Execution_Context up front so even an install-phase short-circuit
  // (no test phase ran) still surfaces a context for the execution (R6.1). The
  // SAME recorded context is then passed to the test phase so the run that
  // actually executes is driven by, and reports, exactly these values.
  const ctx = recordExecutionContext(request.executionContext);

  // PHASE ONE: install dependencies through the registry-proxy topology, then
  // tear that topology down (runInstallPhase always does so in a finally). The
  // test phase MUST NOT begin until this completes (R5.4).
  const install = await runInstallPhase(
    propertyId,
    targetRepoPath,
    request.install ?? {},
  );

  // Install did not complete — surface its closed non-VERDICT result UNCHANGED
  // and DO NOT run the test phase. The ordering guarantee: no test container is
  // ever created unless the install fully succeeded first. Still pair it with
  // the recorded context (R6.1).
  if (!install.ok) {
    return { result: install.result, executionContext: ctx };
  }

  // PHASE TWO: now that the install is done and its network is gone, run the
  // property with NO NETWORK at all, seeded/clock-pinned from the recorded ctx.
  return runTestPhaseWithContext({
    propertyId,
    targetRepoPath,
    propertyTestFile: request.propertyTestFile,
    executionContext: ctx,
    timeoutSeconds: request.timeoutSeconds,
    image: request.image,
  });
}
