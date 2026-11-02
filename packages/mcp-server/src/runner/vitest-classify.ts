/**
 * Shared Vitest-report classification for the rootless Podman runners.
 *
 * This module is the SINGLE SOURCE OF TRUTH for turning Vitest's
 * `--reporter=json` output into the closed `ActualResult` union. It was
 * extracted verbatim from the walking-skeleton runner
 * ({@link ./podman-runner.ts}, task 4.2) so BOTH the single-container skeleton
 * runner AND the two-phase test runner ({@link ./test-phase.ts}, task 9.2)
 * classify identically — the pinned fast-check 3.x / vitest 2.x failure-message
 * shapes the classifier keys off of are load-bearing, and duplicating the logic
 * across two runners would risk the two drifting apart.
 *
 * CLASSIFICATION CONTRACT (unchanged from task 4.2):
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
 *                       classifier is reached; the TIMEOUT it emits carries a
 *                       sentinel `limitSeconds: 0` the caller rewrites with the
 *                       configured per-run limit.)
 *  - VERDICT PASS     — tests ran, ALL passed, zero failed suites, and no
 *                       top-level unhandled errors.
 *
 * When in doubt between FAIL and EXECUTION_ERROR, prefer EXECUTION_ERROR: a
 * false "contradiction" is strictly worse than an honest "couldn't evaluate".
 *
 * WHY THE TOOLCHAIN IS PINNED. The classifier distinguishes a genuine assertion
 * FAIL from a thrown non-assertion error by the SHAPE of fast-check's failure
 * message, which is version-dependent. fast-check 3.x's async failure message
 * includes the wrapped inner error inline ("Got AssertionError: …" for a failed
 * assertion vs "Got error: …" for a thrown error) and the property's own custom
 * message; fast-check 4.x's async path OMITS that inner-error line by default,
 * which would collapse the assertion-vs-thrown distinction. Both runners install
 * the same pinned 3.x / 2.x toolchain so this classification signal stays
 * deterministic.
 */
import type { ActualResult, ExecutionContext } from "@spec-lantern/types";

/**
 * Pinned test-toolchain versions installed inside the container by both runners.
 *
 * These are pinned deliberately — NOT merely for reproducibility, but because
 * the classifier distinguishes a genuine assertion FAIL from a thrown
 * non-assertion error by the SHAPE of fast-check's failure message, and that
 * shape is version-dependent (see the module header). Pinning to the 3.x line
 * (matching the repo's own devDependencies) keeps both the classification signal
 * and the readable counterexample deterministic; vitest is pinned to the
 * matching 2.x line for the same reason.
 */
export const PINNED_TEST_TOOLCHAIN = [
  "vitest@^2.1.8",
  "fast-check@^3.23.2",
  "jsdom@^25.0.1",
  "@testing-library/react@^16.1.0",
  "@testing-library/jest-dom@^6.6.3",
].join(" ");

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
 * See the module header for the full classification contract.
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
        // see each runner where this is rewritten before return.
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
export function parseVitestJson(
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
