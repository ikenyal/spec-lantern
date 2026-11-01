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

/**
 * Pinned test-toolchain versions installed inside the container.
 *
 * These are pinned deliberately — NOT merely for reproducibility, but because
 * the classifier in this module distinguishes a genuine assertion FAIL from a
 * thrown non-assertion error by the SHAPE of fast-check's failure message, and
 * that shape is version-dependent. fast-check 3.x's async failure message
 * includes the wrapped inner error inline ("Got AssertionError: …" for a failed
 * assertion vs "Got error: …" for a thrown error) and the property's own custom
 * message; fast-check 4.x's async path OMITS that inner-error line by default,
 * which would collapse the assertion-vs-thrown distinction and also drop the
 * readable "expected first row: …, actual first row: …" summary. Pinning to the
 * 3.x line (matching the repo's own devDependencies) keeps both the
 * classification signal and the readable counterexample deterministic. vitest
 * is pinned to the matching 2.x line for the same reason.
 */
const PINNED_TEST_TOOLCHAIN = [
  "vitest@^2.1.8",
  "fast-check@^3.23.2",
  "jsdom@^25.0.1",
  "@testing-library/react@^16.1.0",
  "@testing-library/jest-dom@^6.6.3",
].join(" ");

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
    // Install the PINNED test toolchain (see PINNED_TEST_TOOLCHAIN): the
    // classifier depends on fast-check 3.x's deterministic async failure-message
    // shape, so these versions are not optional. Not `|| true` — if the pinned
    // toolchain cannot be installed the run must surface as an execution error,
    // not silently fall back to whatever (possibly 4.x) version resolves.
    `npm install --ignore-scripts --no-audit --no-fund --save-dev ${PINNED_TEST_TOOLCHAIN}`,
    // Run exactly one file; JSON reporter to a file we read back from the mount.
    `npx vitest run ${inContainerTestPath} --reporter=json --outputFile=${CONTAINER_WORKDIR}/.spec-lantern-result.json --no-color`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Vitest JSON report classification (task 4.2 revision)                      */
/* -------------------------------------------------------------------------- */

/**
 * The subset of Vitest's `--reporter=json` shape this classifier relies on.
 * Only structured fields are declared; string matching is used ONLY to tell an
 * assertion failure apart from a thrown error / a timeout, which Vitest does
 * NOT expose as a distinct structured status (a thrown test, an assertion
 * failure, and a test-level timeout all land as `assertionResults[].status ===
 * "failed"`). The discriminators below are keyed off the failure message's
 * leading error class, which Vitest/fast-check emit deterministically and
 * locale-independently (error names are not localized).
 */
interface VitestJsonReport {
  numTotalTests?: number;
  numFailedTests?: number;
  numPassedTests?: number;
  numTotalTestSuites?: number;
  numFailedTestSuites?: number;
  /** Top-level suite-load / unhandled errors (module/import/transform failures). */
  unhandledErrors?: unknown[];
  testResults?: Array<{
    /** Suite-level status; "failed" with zero assertions ⇒ a load failure. */
    status?: string;
    /** Suite-level message — populated for module-load/transform failures. */
    message?: string;
    assertionResults?: Array<{
      status?: string;
      title?: string;
      fullName?: string;
      failureMessages?: string[];
    }>;
  }>;
}

/**
 * How a single failing test's failure message was classified. This is the
 * bridge between Vitest's flat "failed" status and the closed ActualResult
 * union: a failing test is only ever a genuine VERDICT FAIL when the underlying
 * throw was an ASSERTION; a thrown non-assertion error or a timeout are NOT
 * contradictions of the property and must surface as EXECUTION_ERROR / TIMEOUT.
 */
type FailureKind = "assertion" | "timeout" | "thrown";

/**
 * Classify a single failing test's failure message into assertion / timeout /
 * thrown.
 *
 * Observed Vitest + fast-check failure-message shapes (empirically verified
 * against vitest 2.1.x; error-class names are emitted verbatim and are not
 * localized, so keying on them is robust — unlike free-prose matching):
 *
 *  - Plain assertion failure:
 *      "AssertionError: <custom msg>: expected 'X' to be 'Y' // Object.is equality"
 *  - Plain thrown error:
 *      "TypeError: Cannot read properties of null (reading 'foo')"
 *      "Error: month label not rendered"
 *  - Per-test timeout:
 *      "Error: Test timed out in 1500ms."
 *    Per-hook timeout:
 *      "Error: Hook timed out in ..."
 *  - fast-check wrapping an assertion (a genuine property FAIL):
 *      "Error: Property failed after N tests ... Counterexample: [...] ... Got AssertionError: <custom msg>: expected 'X' to be 'Y'"
 *  - fast-check wrapping a thrown error (NOT a property FAIL):
 *      "Error: Property failed after N tests ... Counterexample: [...] ... Got error: <message>"
 *
 * Precedence: TIMEOUT first (a timed-out assertion must never read as FAIL),
 * then ASSERTION, then everything else is a thrown error.
 */
function classifyFailureMessage(failureMessage: string): FailureKind {
  const msg = failureMessage;

  // 1. Timeouts — a per-test or per-hook timeout. Vitest phrases these as
  //    "Test timed out in <n>ms" / "Hook timed out in ...". Checked FIRST so a
  //    hung property/assertion surfaces as TIMEOUT, not FAIL or EXECUTION_ERROR.
  if (/\b(?:test|hook)\s+timed out\b/i.test(msg) || /\btimed out in\b/i.test(msg)) {
    return "timeout";
  }

  // 2. Assertion failures. fast-check re-emits the inner error prefixed with
  //    "Got AssertionError:"; a plain assertion starts with "AssertionError:".
  //    Vitest/chai assertion errors are named AssertionError regardless of
  //    locale. The "expected … to be …" diff is a secondary structural signal.
  if (/\bAssertionError\b/.test(msg)) {
    // Guard against a thrown error that merely mentions the word: fast-check's
    // "Got error:" prefix only appears for NON-assertion throws, so if the
    // message is a fast-check wrapper, require the assertion marker in the
    // wrapped portion.
    if (/Property failed after/.test(msg)) {
      return /Got AssertionError\b/.test(msg) ? "assertion" : "thrown";
    }
    return "assertion";
  }

  // 3. fast-check wrapping a thrown (non-assertion) error.
  if (/Property failed after/.test(msg) && /Got error:/.test(msg)) {
    return "thrown";
  }

  // 4. Anything else that reached here is a thrown non-assertion error
  //    (TypeError, bare Error, component crash on render, etc.).
  return "thrown";
}

/**
 * Pull the first failing assertion's joined failure message out of the report,
 * if any. Returns "" when no failing assertion exists (e.g. a suite-load
 * failure with zero assertion results).
 */
function firstFailureMessage(report: VitestJsonReport): string {
  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === "failed") {
        return (assertion.failureMessages ?? []).join("\n");
      }
    }
  }
  return "";
}

/**
 * Detect a module-load / import / transform failure: a failed test SUITE that
 * produced zero assertion results (the file never got far enough to register a
 * test), optionally carrying a suite-level `message`. Returns the suite message
 * (for the EXECUTION_ERROR reason) when such a failure is present, else null.
 */
function suiteLoadFailureMessage(report: VitestJsonReport): string | null {
  for (const suite of report.testResults ?? []) {
    const assertions = suite.assertionResults ?? [];
    if (suite.status === "failed" && assertions.length === 0) {
      return (suite.message ?? "").trim() || "test suite failed to load";
    }
  }
  return null;
}

/**
 * Classify a Vitest JSON report into the closed {@link ActualResult} union.
 *
 * Classification contract (task 4.2 revision):
 *  - VERDICT FAIL     — a test ran and failed because an ASSERTION failed
 *                       (an AssertionError from `expect(...)`; fast-check
 *                       re-emits this as "Got AssertionError:"). ONLY this is a
 *                       genuine "prediction contradicted".
 *  - EXECUTION_ERROR  — the property did not cleanly pass or fail as an
 *                       assertion: a thrown non-assertion error, a module-load /
 *                       import / transform failure, a missing/unparseable
 *                       report, an unhandled top-level error, or no tests at all.
 *  - TIMEOUT          — Vitest reported a per-test/hook timeout. (The podman
 *                       wall-clock timeout is handled by the caller before this
 *                       function is reached.)
 *  - VERDICT PASS     — tests ran, ALL passed, zero failed suites, and no
 *                       top-level unhandled errors.
 *
 * When in doubt between FAIL and EXECUTION_ERROR, prefer EXECUTION_ERROR: a
 * false "contradiction" is strictly worse than an honest "couldn't evaluate".
 */
function classifyVitestReport(
  propertyId: string,
  report: VitestJsonReport,
  stderr: string,
  ctx: ExecutionContext,
): ActualResult {
  const total = report.numTotalTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failedSuites = report.numFailedTestSuites ?? 0;
  const unhandled = report.unhandledErrors ?? [];

  // (a) Module-load / suite-load failure: a failed suite with no assertion
  //     results means the file (or an import) failed to load before any test
  //     registered. Honest EXECUTION_ERROR, never a verdict.
  const loadFailure = suiteLoadFailureMessage(report);
  if (loadFailure !== null) {
    return {
      propertyId,
      outcome: "EXECUTION_ERROR",
      reason: `test file failed to load: ${loadFailure.slice(0, 500)}`,
    };
  }

  // (b) Top-level unhandled errors (module graph / transform problems surfaced
  //     outside any test). Also EXECUTION_ERROR.
  if (unhandled.length > 0) {
    const text = unhandled
      .map((e) =>
        typeof e === "string"
          ? e
          : (e as { message?: string; stack?: string })?.message ??
            (e as { stack?: string })?.stack ??
            JSON.stringify(e),
      )
      .join("; ");
    return {
      propertyId,
      outcome: "EXECUTION_ERROR",
      reason: `unhandled error during execution: ${text.trim().slice(0, 500)}`,
    };
  }

  // (c) No test ran at all — neither passed nor failed. Execution error.
  if (total === 0 && passed === 0 && failed === 0) {
    const detail = stderr.trim().slice(0, 500);
    return {
      propertyId,
      outcome: "EXECUTION_ERROR",
      reason: `no tests executed for property ${propertyId}${detail ? `: ${detail}` : ""}`,
    };
  }

  // (d) A failing test exists — classify WHY it failed.
  if (failed > 0) {
    const failureMessage = firstFailureMessage(report);
    const kind = classifyFailureMessage(failureMessage);

    if (kind === "timeout") {
      // A Vitest-level per-test/hook timeout. The podman wall-clock limit was
      // not hit (that path returns earlier), so we cannot know the exact limit
      // in effect from the report alone; the configured per-run limit is passed
      // through by the caller via `limitSeconds`.
      return {
        propertyId,
        outcome: "TIMEOUT",
        // Sentinel 0 is replaced by the caller with the real configured limit;
        // see runPropertyInContainer where this is rewritten before return.
        limitSeconds: 0,
      };
    }

    if (kind === "thrown") {
      return {
        propertyId,
        outcome: "EXECUTION_ERROR",
        reason: `property threw a non-assertion error (did not evaluate to PASS/FAIL): ${thrownErrorDetail(
          failureMessage,
        ).slice(0, 500)}`,
      };
    }

    // kind === "assertion": a genuine property/assertion FAIL.
    return {
      propertyId,
      outcome: "VERDICT",
      verdict: "FAIL",
      counterexample: {
        propertyId,
        input: extractCounterexampleInput(failureMessage),
        observedOutput: buildObservedOutput(failureMessage),
        executionContext: ctx,
      },
    };
  }

  // (e) A failed suite count with no failing test and no load failure we could
  //     attribute — treat conservatively as EXECUTION_ERROR rather than PASS.
  if (failedSuites > 0) {
    return {
      propertyId,
      outcome: "EXECUTION_ERROR",
      reason: `a test suite failed without a classifiable assertion failure (${failedSuites} failed suite(s))`,
    };
  }

  // (f) Everything that ran passed, no failed suites, no unhandled errors.
  return { propertyId, outcome: "VERDICT", verdict: "PASS" };
}

/**
 * Parse Vitest's JSON report (written inside the mount, read back from the host
 * filesystem view of the same directory) into an {@link ActualResult}, applying
 * the full classification contract above. A report that cannot be parsed is an
 * EXECUTION_ERROR (never a verdict).
 */
function parseVitestJson(
  propertyId: string,
  reportRaw: string,
  stderr: string,
  ctx: ExecutionContext,
): ActualResult {
  let report: VitestJsonReport;
  try {
    report = JSON.parse(reportRaw) as VitestJsonReport;
  } catch {
    return {
      propertyId,
      outcome: "EXECUTION_ERROR",
      reason: `could not parse Vitest JSON report: ${stderr.trim().slice(0, 500)}`,
    };
  }
  return classifyVitestReport(propertyId, report, stderr, ctx);
}

/* -------------------------------------------------------------------------- */
/* Counterexample readability (task 4.2 revision, goal 2)                     */
/* -------------------------------------------------------------------------- */

/**
 * Build a human-readable `observedOutput` for a VERDICT FAIL counterexample.
 *
 * Preference order (most readable first):
 *  1. The property's own custom message of the form
 *     "expected first row: Jan 2000, actual first row: Aug 1999" — Task 4.1's
 *     property emits exactly this. Surfacing it makes the FAIL read naturally
 *     instead of dumping a raw stack trace.
 *  2. A concise "expected X, actual Y" derived from Vitest's structured
 *     "expected '…' to be '…'" diff line.
 *  3. The first meaningful failure line as a last resort.
 *
 * A little raw context is retained after the readable summary (bounded length),
 * so the stack is still available without burying the lede.
 */
function buildObservedOutput(failureMessage: string): string {
  const summary = readableFailureSummary(failureMessage);
  const context = summarizeFailureLine(failureMessage);
  // Lead with the readable summary; append a trimmed slice of the raw message
  // for context only when it adds something beyond the summary itself.
  if (summary && !context.startsWith(summary)) {
    return `${summary}\n---\n${context}`.slice(0, 1200);
  }
  return (summary || context).slice(0, 1200);
}

/**
 * Extract the most readable expected-vs-actual summary from a failure message,
 * or "" when none can be derived. Pure string → string; order mirrors the
 * preference list in {@link buildObservedOutput}.
 */
function readableFailureSummary(failureMessage: string): string {
  // 1. The property's custom "expected first row: …, actual first row: …" line.
  const custom = /expected first row:[^\n]*?,\s*actual first row:[^\n]*/i.exec(
    failureMessage,
  );
  if (custom) return custom[0].trim();

  // 2. Vitest's structured diff: "expected 'X' to be 'Y'" (optionally with a
  //    custom-message prefix before it). Normalize into "expected Y, actual X".
  const diff = /expected\s+(.+?)\s+to\s+(?:be|equal|deeply equal)\s+(.+?)(?:\s*\/\/|\n|$)/i.exec(
    failureMessage,
  );
  if (diff) {
    const actual = diff[1].trim();
    const expected = diff[2].trim();
    return `expected ${expected}, actual ${actual}`;
  }

  return "";
}

/**
 * Surface the ACTUAL thrown-error detail for an EXECUTION_ERROR reason. When
 * fast-check wraps a thrown (non-assertion) error it emits a "Got error: <msg>"
 * line — prefer that over the opaque "Property failed after N tests" wrapper
 * header so the reason names what really went wrong. Falls back to the first
 * meaningful line for a plain (non-fast-check) throw.
 */
function thrownErrorDetail(failureMessage: string): string {
  const got = /Got error:\s*(.+)/.exec(failureMessage);
  if (got) return got[1].trim();
  return summarizeFailureLine(failureMessage);
}

/**
 * The first meaningful (non-empty, non-noise) line of a failure message,
 * trimmed. Used as the fallback observed-output and in EXECUTION_ERROR reasons.
 */
function summarizeFailureLine(failureMessage: string): string {
  const line = failureMessage
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("at "));
  return (line ?? failureMessage.trim()).slice(0, 600);
}

/**
 * Best-effort extraction of the fast-check shrunk counterexample (the
 * triggering input) from a failure message. fast-check prints a line like
 *   "Counterexample: [ ... ]"
 * We return that payload as a string; fully structured parsing is a later
 * concern. Falls back to the first meaningful line when absent.
 */
function extractCounterexampleInput(failureMessage: string): unknown {
  const match = /Counterexample:\s*(.+)/.exec(failureMessage);
  if (match) return match[1].trim();
  return summarizeFailureLine(failureMessage) || null;
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

    const classified = parseVitestJson(propertyId, reportRaw, proc.stderr, ctx);
    // A Vitest-reported per-test/hook timeout carries a sentinel limitSeconds=0
    // from the classifier (which cannot see the configured limit). Rewrite it
    // with the per-run limit actually in effect so the TIMEOUT outcome reports
    // the real limit, exactly like the podman wall-clock timeout path does.
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
