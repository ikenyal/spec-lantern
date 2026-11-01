/**
 * Minimal local rootless Podman runner for ONE Correctness_Property (task 4.2).
 *
 * This is the walking-skeleton runner: it proves the non-negotiable host-safety
 * invariant — *target code runs inside a container, never on the host process or
 * host shell* — on the thinnest possible vertical slice. It takes a single
 * Correctness_Property test file plus the target repo path, spins up a rootless
 * Podman container that mounts ONLY the target repo working directory, installs
 * the target's dependencies inside the container, runs the one test file through
 * Vitest inside the container, and returns an {@link ActualResult}.
 *
 * Scope boundaries (deliberately deferred to later tasks):
 *  - Network topology is minimal here. The full two-phase install/test network
 *    hardening (internal-only Podman network + Verdaccio registry proxy, then a
 *    no-network test phase) is task 9. This module keeps topology minimal; the
 *    only invariant it enforces now is container-not-host execution.
 *  - The Safety Gate (task 8), Execution_Context pinning across the boundary
 *    (task 10.3), and the general Isolated_Runner interface (task 8.2) are
 *    separate tasks. This module is the concrete skeleton those tasks generalize.
 *
 * Host-safety invariants honored here (see steering 00-pipeline-and-safety.md):
 *  1. No host execution — install + Vitest run ONLY via `podman run`, never in
 *     the host shell. There is no code path in this module that runs the target
 *     repo's install, build, or test on the host.
 *  2. No host fallback — if Podman is absent or the container cannot be created,
 *     the runner returns RUNNER_UNAVAILABLE and stops. It never degrades to
 *     running the target on the host.
 *  3. Boundary confinement — the container mounts ONLY the target repo working
 *     directory; file access is confined to that mount.
 *
 * macOS mount discipline (hard constraints):
 *  - The target directory is bound with a PLAIN bind mount. No `:Z` SELinux
 *    relabel is ever applied to the (broad) target path — macOS is not an
 *    SELinux host and relabeling a broad shared path is wrong there.
 *  - Only the specific target working directory is mounted. Never `$HOME`, and
 *    never any other broad path.
 *  - Nothing the container must see is placed under `/tmp`. On macOS the Podman
 *    machine shares `/Users` but NOT the host `/tmp`, so a host `/tmp/...` path
 *    is invisible inside the container. Every file the container reads or writes
 *    (the property test file, any staged copy, and the Vitest result JSON) lives
 *    UNDER THE MOUNTED REPO — i.e. under `/Users` — so it is visible in the VM.
 *
 * The returned shape is the closed `ActualResult` union from
 * `@spec-lantern/types`; this module never invents new result shapes.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ActualResult, ExecutionContext } from "@spec-lantern/types";

/**
 * Request to run exactly one Correctness_Property test file inside the runner.
 *
 * This is the interface task 4.3 calls to dispatch one property into the runner.
 */
export interface PodmanRunnerRequest {
  /** The property this run evaluates (propagated onto the ActualResult). */
  propertyId: string;
  /**
   * Absolute path to the target repo working directory. This — and only this —
   * directory is mounted into the container (R12.6 boundary confinement).
   */
  targetRepoPath: string;
  /**
   * The single Correctness_Property test file to execute. Either:
   *  - a path already inside `targetRepoPath` (relative or absolute), in which
   *    case it is run in place from within the mount, or
   *  - an absolute path outside the repo, in which case it is staged into a
   *    temp location inside the mounted working directory before the run.
   * The file never executes on the host regardless of where it originates.
   */
  propertyTestFile: string;
  /**
   * Execution_Context pinned for this run. Defaults are generated when omitted
   * (a random seed, UTC, and a fixed instant). Full propagation of this context
   * through fast-check/the clock is task 10.3; here it is recorded and attached
   * to any Counterexample so the result is self-describing.
   */
  executionContext?: ExecutionContext;
  /**
   * Per-run execution timeout in seconds. Default 30 (R5.7). Exceeding it
   * terminates the container and yields a TIMEOUT outcome (never PASS/FAIL).
   */
  timeoutSeconds?: number;
  /**
   * Container image that provides Node + a package manager. Defaults to a
   * current Node LTS image. The image must be pullable or already present.
   */
  image?: string;
}

/** Default per-run execution timeout in seconds (R5.7). */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** Default container base image (Node LTS with npm available). */
const DEFAULT_IMAGE = "docker.io/library/node:20-bookworm-slim";

/** Where the target repo is mounted inside the container. */
const CONTAINER_WORKDIR = "/work";

/** Result of a raw process invocation. */
interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command, capturing stdout/stderr. Never runs target repo code — callers
 * only use this for `podman` itself. An optional timeout kills the process tree.
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
        // SIGKILL the podman client; the container is reaped separately by the
        // caller via `podman rm -f` so no stray container survives a timeout.
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
      // ENOENT etc. — surface as a non-zero result the caller classifies.
      stderr += `\n${err.message}`;
      resolvePromise({ code: null, signal: null, stdout, stderr, timedOut });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/** Build the default Execution_Context when the caller did not pin one. */
function defaultExecutionContext(): ExecutionContext {
  // A deterministic-enough seed for the skeleton; full seeding is task 10.3.
  const randomSeed = randomBytes(4).readUInt32BE(0);
  return {
    randomSeed,
    timezone: "UTC",
    // A fixed instant so the run is reproducible if the clock were honored.
    fixedCurrentTime: "2025-01-01T00:00:00.000Z",
  };
}

/**
 * Detect whether Podman is usable (binary present AND the machine/engine is
 * reachable). Returns a reason string when unavailable, or null when ready.
 */
async function detectPodmanUnavailable(): Promise<string | null> {
  const probe = await runProcess("podman", ["info", "--format", "{{.Version.Version}}"], {
    timeoutMs: 15_000,
  });
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

/**
 * Determine the path, relative to the mounted working directory, at which the
 * property test file will be visible inside the container. If the file already
 * lives inside the target repo it is used in place; otherwise it is staged into
 * the mount so it is reachable from within the boundary (and only there).
 *
 * Returns the in-container absolute path plus a cleanup callback for any staged
 * copy.
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
 * Compose the shell script that runs ENTIRELY INSIDE the container: install the
 * target's deps, then run the single property test file through Vitest. Vitest
 * and fast-check are added on top of the target's own deps for the skeleton.
 *
 * This string is executed by the container's shell via `podman run ... sh -c`,
 * never by the host shell.
 */
function buildInContainerScript(
  inContainerTestPath: string,
  ctx: ExecutionContext,
): string {
  // Keep it minimal and robust: install target deps ignoring lifecycle scripts
  // (defense-in-depth even before task 9 topology), then ensure a test runner is
  // present, then run exactly the one file with JSON reporter to a known path.
  return [
    "set -e",
    `export TZ='${ctx.timezone}'`,
    `cd ${CONTAINER_WORKDIR}`,
    // Install target deps. --ignore-scripts prevents arbitrary lifecycle code.
    "npm install --ignore-scripts --no-audit --no-fund",
    // Ensure the test toolchain exists inside the container (skeleton: add if missing).
    "npm install --ignore-scripts --no-audit --no-fund --save-dev vitest fast-check jsdom @testing-library/react @testing-library/jest-dom || true",
    // Run exactly one file; JSON reporter to a file we read back from the mount.
    `npx vitest run ${inContainerTestPath} --reporter=json --outputFile=${CONTAINER_WORKDIR}/.spec-lantern-result.json --no-color`,
  ].join("\n");
}

/**
 * Parse Vitest's JSON report (written inside the mount, read back from the host
 * filesystem view of the same directory) into an ActualResult.
 *
 * - All assertion tests passing -> VERDICT PASS.
 * - Any failing assertion -> VERDICT FAIL with a Counterexample carrying the
 *   triggering input (best-effort from the failure message) and observed output.
 * - A report that cannot be read/parsed -> EXECUTION_ERROR.
 */
function parseVitestJson(
  propertyId: string,
  reportRaw: string,
  stderr: string,
  ctx: ExecutionContext,
): ActualResult {
  let report: unknown;
  try {
    report = JSON.parse(reportRaw);
  } catch {
    return {
      propertyId,
      outcome: "EXECUTION_ERROR",
      reason: `could not parse Vitest JSON report: ${stderr.trim().slice(0, 500)}`,
    };
  }

  const r = report as {
    numTotalTests?: number;
    numFailedTests?: number;
    numPassedTests?: number;
    testResults?: Array<{
      assertionResults?: Array<{
        status?: string;
        title?: string;
        fullName?: string;
        failureMessages?: string[];
      }>;
    }>;
  };

  const total = r.numTotalTests ?? 0;
  const failed = r.numFailedTests ?? 0;
  const passed = r.numPassedTests ?? 0;

  // No test ran at all — the file neither passed nor failed: execution error,
  // never folded into PASS/FAIL (closed-union discipline, R5.9).
  if (total === 0 && passed === 0 && failed === 0) {
    return {
      propertyId,
      outcome: "EXECUTION_ERROR",
      reason: `no tests executed for property ${propertyId}: ${stderr.trim().slice(0, 500)}`,
    };
  }

  if (failed > 0) {
    // Collect the first failing assertion's message as the Counterexample source.
    let failureMessage = "";
    for (const suite of r.testResults ?? []) {
      for (const assertion of suite.assertionResults ?? []) {
        if (assertion.status === "failed") {
          failureMessage = (assertion.failureMessages ?? []).join("\n");
          break;
        }
      }
      if (failureMessage) break;
    }

    return {
      propertyId,
      outcome: "VERDICT",
      verdict: "FAIL",
      counterexample: {
        propertyId,
        // fast-check embeds the shrunk counterexample in its failure message;
        // we surface the raw message as the triggering input for the skeleton.
        // Later tasks parse structured fast-check output.
        input: extractCounterexampleInput(failureMessage),
        observedOutput: failureMessage.trim().slice(0, 2000),
        executionContext: ctx,
      },
    };
  }

  // Everything that ran passed.
  return { propertyId, outcome: "VERDICT", verdict: "PASS" };
}

/**
 * Best-effort extraction of the fast-check counterexample from a failure
 * message. fast-check prints a line like
 *   "Counterexample: [ ... ]"
 * We return that payload as a string; structured parsing is a later concern.
 */
function extractCounterexampleInput(failureMessage: string): unknown {
  const match = /Counterexample:\s*(.+)/.exec(failureMessage);
  if (match) return match[1].trim();
  // Fall back to the first non-empty line of the failure.
  const firstLine = failureMessage
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine ?? null;
}

/**
 * Run exactly one Correctness_Property test file inside a rootless Podman
 * container and return its ActualResult.
 *
 * This is the function task 4.3 calls to dispatch one property into the runner.
 *
 * Guarantees:
 *  - If Podman is unavailable or the container cannot be created, returns
 *    RUNNER_UNAVAILABLE and NEVER runs the target on the host.
 *  - The container mounts ONLY `targetRepoPath`; install + Vitest run inside it.
 *  - The result is one of the closed ActualResult shapes. Timeouts and errors
 *    are their own outcomes, never PASS/FAIL.
 */
export async function runPropertyInContainer(
  request: PodmanRunnerRequest,
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
  // Unique container name so we can force-remove it even on timeout.
  const containerName = `spec-lantern-${createHash("sha1")
    .update(`${propertyId}:${Date.now()}:${randomBytes(4).toString("hex")}`)
    .digest("hex")
    .slice(0, 16)}`;

  let staged: { inContainerPath: string; cleanup: () => Promise<void> } | undefined;

  try {
    staged = await resolveTestFileInMount(repoAbs, propertyTestFile);
    const script = buildInContainerScript(staged.inContainerPath, ctx);

    // 2. Run inside the container. ONLY the target working dir is mounted with a
    //    PLAIN bind mount — never a home directory or other broad path, and no
    //    `:Z` relabel. On macOS the Podman machine shares `/Users` into the VM,
    //    so a `/Users/...` bind mount is visible in the container; a `:Z` SELinux
    //    relabel on a broad shared path is both unnecessary and wrong on macOS
    //    (it is not a labeled host and relabeling a broad path is unsafe), so it
    //    is deliberately omitted. Minimal topology for now — full two-phase
    //    network hardening is task 9. Nothing the container must see lives under
    //    `/tmp` or `$HOME`: the test file is run in place inside this mount (or
    //    staged into a temp dir *under the repo*), and the result JSON is written
    //    inside this same mount — all under `/Users`, all visible in the VM.
    const podmanArgs = [
      "run",
      "--rm",
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

    // 4. Container creation / run failure that is not a test failure.
    //    `podman run` exiting 125 means the container could not be created.
    if (proc.code === 125) {
      return {
        propertyId,
        outcome: "RUNNER_UNAVAILABLE",
        reason: `container could not be created: ${proc.stderr.trim().slice(0, 500)}`,
      };
    }

    // 5. Read the Vitest JSON report back from the mounted dir (host view of the
    //    same files the container wrote). Reading a file is not executing code.
    const reportHostPath = join(repoAbs, ".spec-lantern-result.json");
    let reportRaw = "";
    try {
      const { readFile } = await import("node:fs/promises");
      reportRaw = await readFile(reportHostPath, "utf8");
    } catch {
      // No report written — classify from exit code/stderr as an execution error.
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

    return parseVitestJson(propertyId, reportRaw, proc.stderr, ctx);
  } catch (err) {
    // Any orchestration failure is an execution error — never a silent host run.
    const message = err instanceof Error ? err.message : String(err);
    return {
      propertyId,
      outcome: "EXECUTION_ERROR",
      reason: `runner orchestration failed: ${message}`,
    };
  } finally {
    if (staged) await staged.cleanup().catch(() => undefined);
    // Defensive: ensure no stray container survives.
    await runProcess("podman", ["rm", "-f", containerName], { timeoutMs: 15_000 }).catch(
      () => undefined,
    );
  }
}
