/**
 * The thinnest end-to-end execute path for the walking skeleton (task 4.3).
 *
 * This module wires the two pieces the earlier skeleton tasks built into one
 * vertical slice that PROVES the "execute, don't trust" thesis on a single
 * property:
 *
 *   task 4.1 artifacts  ──►  task 4.2 runner  ──►  surfaced contradiction
 *   (Claim + property +      (runPropertyIn-        (comment-trusting PASS
 *    comment-trusting         Container, rootless    prediction vs the
 *    PASS prediction)         Podman)                execution-observed FAIL)
 *
 * Why this file was REVISED. Task 4.1's property no longer reproduces
 * `getPeriods()` inline — it imports and RENDERS the REAL writing-tracker
 * `PeriodProgressSummary` component (via the `@` → src alias) in jsdom, clicks
 * the "Monthly" tab, and reads the first monthly row's label off the real DOM.
 * A minimal `package.json` + property-file fixture therefore can no longer
 * resolve the import. So the execute path now stands up a real, runnable copy
 * of writing-tracker and mounts THAT.
 *
 * What it does, minimally:
 *  1. Loads the task-4.1 Claim / property-test-file / Predicted_Result for the
 *     writing-tracker monthly-ordering claim, using `resolveClaimLinkage()`
 *     from `@spec-lantern/types` to derive the on-disk paths from the Claim id
 *     and property number (so the 1:1 Claim → property → prediction linkage is
 *     resolved from the canonical layout, not hard-coded paths).
 *  2. Reads the read-only, comment-trusting Predicted_Result (PASS).
 *  3. Copies `sandbox/writing-tracker` (READ-ONLY source — never mutated) into a
 *     GITIGNORED working copy UNDER THE REPO (under `/Users`, because the macOS
 *     Podman machine shares `/Users` but NOT `/tmp`), excluding `node_modules`,
 *     `.git` and build output so the container installs deps fresh. It drops the
 *     task-4.1 property test file into the working copy under
 *     `src/__spec_lantern__/` (covered by the `@` alias + the include glob) and
 *     writes a `vitest.config.ts` INSIDE the working copy that defines the `@` →
 *     `src` alias, sets the jsdom environment, and includes the property file.
 *  4. Dispatches the ONE property through `runTwoPhase` — the task-9
 *     two-phase rootless-Podman runner — mounting ONLY the working copy and
 *     executing the property against the REAL component INSIDE a container,
 *     never on the host. Phase one installs the target's deps + the pinned
 *     test toolchain through the internal-only network + Verdaccio proxy; phase
 *     two runs Vitest with `--network none` against what was installed.
 *  5. Compares the executed `ActualResult` (expected VERDICT FAIL, oldest-month
 *     first, with its Counterexample) against the PASS prediction and SURFACES
 *     the contradiction.
 *
 * Supabase dependency note. The real component imports `Book` from
 * `../../services/bookService`, which imports `@/integrations/supabase/client`.
 * That `Book` import is TYPE-ONLY, so esbuild/Vite elides it and the supabase
 * module graph is never pulled in at runtime — the real `getPeriods()` runs
 * without any backend. As belt-and-suspenders (and so the slice stays robust if
 * a future edit turns that into a value import), the working-copy vitest config
 * also aliases `@/integrations/supabase/client` to a tiny inert stub. This
 * mocks ONLY the unrelated backend dependency, never the component under test or
 * its ordering logic.
 *
 * Scope: this is the THIN skeleton wiring, not the full pipeline. Prediction
 * locking (task 7), the Safety Gate (task 8), the Comparison Engine (task 14),
 * the Revive loop (task 15), report assembly (task 16) and the UI (task 18) are
 * deliberately NOT here. The two-phase network topology (task 9) IS now wired
 * in: the dispatch goes through `runTwoPhase`. The one
 * exported entry point — {@link executeWalkingSkeleton} — is the seam those
 * later tasks build on: it already returns the prediction, the actual result,
 * and the surfaced mismatch in structured form.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveClaimLinkage,
  type ActualResult,
  type PredictedResult,
  type Verdict,
} from "@spec-lantern/types";
import { runTwoPhase } from "./runner/test-phase.js";

/* -------------------------------------------------------------------------- */
/* Skeleton artifact coordinates (task 4.1)                                   */
/* -------------------------------------------------------------------------- */

/** The one Claim the walking skeleton evaluates. */
const SKELETON_CLAIM_ID = "claim-monthly-order";

/** Its property number (`property-1.claim-monthly-order.*`). */
const SKELETON_PROPERTY_NUMBER = 1;

/**
 * The propertyId the runner and prediction agree on. It matches the
 * `{n}.{claimId}` stem of the on-disk artifact filenames, which is also what
 * the task-4.1 Predicted_Result records.
 */
const SKELETON_PROPERTY_ID = `property-${SKELETON_PROPERTY_NUMBER}.${SKELETON_CLAIM_ID}`;

const here = dirname(fileURLToPath(import.meta.url));

/** The repo root, resolved from the compiled module (dist/) location. */
const REPO_ROOT = resolve(here, "..", "..", "..");

/**
 * Default spec root holding the task-4.1 artifacts:
 *   packages/mcp-server/skeleton/writing-tracker-monthly-order/
 * Resolved relative to the compiled module (dist/) so it works from the built
 * package as well as ts-node style runs.
 */
const DEFAULT_SPEC_ROOT = resolve(
  here,
  "..",
  "skeleton",
  "writing-tracker-monthly-order",
);

/**
 * The READ-ONLY source Target_Repo. Never written to — we only copy OUT of it.
 */
const DEFAULT_TARGET_SOURCE = resolve(REPO_ROOT, "sandbox", "writing-tracker");

/**
 * Directory that HOLDS the per-run working copies (gitignored). Each run gets
 * its OWN uniquely-named subdir under `skeleton/` (see
 * {@link makeUniqueWorktreeDir}); this is just the parent location. It MUST live
 * under the repo (under `/Users` on macOS) so the working copy is visible
 * inside the Podman machine, which shares `/Users` but NOT `/tmp`.
 */
const WORKTREE_PARENT_DIR = resolve(here, "..", "skeleton");

/** Base name every per-run working copy starts with (gitignored via `.worktree*`). */
const WORKTREE_BASENAME = ".worktree";

/**
 * Build a UNIQUE per-run working-copy directory path. Fixed directory names let
 * two concurrent runs (e.g. two smoke test files, or a watch re-run overlapping
 * the previous) clobber each other's files mid-copy — the `cp`/`rm` race that
 * surfaces as `ENOTEMPTY`. A per-run random token makes every run's copy
 * disjoint, so concurrent runs cannot collide. The name keeps the `.worktree`
 * prefix so the `.worktree*` gitignore pattern still covers it, and stays under
 * the repo (under `/Users`) so it is visible inside the Podman machine.
 *
 * @param label optional short tag embedded in the name (e.g. a test id) purely
 *   to make a stray directory easy to attribute while debugging.
 */
function makeUniqueWorktreeDir(label?: string): string {
  const token = randomBytes(6).toString("hex");
  const suffix = label ? `-${label}` : "";
  return resolve(WORKTREE_PARENT_DIR, `${WORKTREE_BASENAME}${suffix}-${token}`);
}

/**
 * Where the property test file lands inside the working copy. Under `src/` so
 * the `@` → `src` alias and the include glob both cover it, and so its own
 * `@/...` imports resolve exactly like the component's.
 */
const WORKTREE_PROPERTY_REL =
  "src/__spec_lantern__/property-1.claim-monthly-order.test.ts";

/* -------------------------------------------------------------------------- */
/* Result shape surfaced to callers                                           */
/* -------------------------------------------------------------------------- */

/**
 * The surfaced outcome of the walking skeleton: the comment-trusting prediction
 * next to the execution-observed actual result, with the mismatch made
 * explicit. This is the structured seam later tasks (comparison, report, UI)
 * consume.
 */
export interface WalkingSkeletonOutcome {
  /** The property that was executed. */
  propertyId: string;
  /** The read-only, comment-trusting prediction loaded from disk (PASS). */
  predicted: PredictedResult;
  /** What executing the property against writing-tracker actually produced. */
  actual: ActualResult;
  /**
   * The predicted verdict vs the actual verdict, when the run produced a
   * verdict. `null` for `actualVerdict` means the run did not terminate in
   * PASS/FAIL (timeout / execution error / runner unavailable) — those are
   * never folded into a verdict.
   */
  predictedVerdict: Verdict;
  actualVerdict: Verdict | null;
  /**
   * TRUE exactly when the run produced a verdict that disagrees with the
   * prediction — i.e. the central contradiction the skeleton exists to prove
   * (comment-trusting PASS vs executed FAIL).
   */
  predictionContradicted: boolean;
  /** Human-readable one-line summary of what was surfaced. */
  summary: string;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface ExecuteWalkingSkeletonOptions {
  /** Spec root holding the task-4.1 artifacts. Defaults to the skeleton dir. */
  specRoot?: string;
  /**
   * READ-ONLY source Target_Repo to copy from. Defaults to
   * `sandbox/writing-tracker`. This directory is never modified.
   */
  targetSource?: string;
  /**
   * Where to create the repo-relative WORKING COPY the container mounts. MUST
   * live under the repo (under `/Users` on macOS). Defaults to
   * `packages/mcp-server/skeleton/.worktree`.
   */
  worktreeDir?: string;
  /**
   * Per-run execution timeout in seconds handed to the runner. Generous by
   * default because the first container run pulls the image and installs the
   * target's full dependency tree (React + Radix + the test toolchain).
   */
  timeoutSeconds?: number;
  /** Keep the working copy on disk after the run (for debugging). */
  keepWorktree?: boolean;
  /** Optional sink for progress lines (defaults to no-op). */
  log?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Artifact loading (task 4.1 → in-memory)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Load the comment-trusting Predicted_Result for the skeleton property from the
 * on-disk prediction file whose path is resolved via `resolveClaimLinkage()`.
 */
async function loadPrediction(specRoot: string): Promise<PredictedResult> {
  const linkage = resolveClaimLinkage(
    specRoot,
    SKELETON_CLAIM_ID,
    SKELETON_PROPERTY_NUMBER,
  );
  const raw = await readFile(linkage.predictedResultFile, "utf8");
  const parsed = JSON.parse(raw) as PredictedResult;

  if (parsed.propertyId !== SKELETON_PROPERTY_ID) {
    throw new Error(
      `prediction propertyId "${parsed.propertyId}" does not match the ` +
        `skeleton property "${SKELETON_PROPERTY_ID}"`,
    );
  }
  if (parsed.verdict !== "PASS" && parsed.verdict !== "FAIL") {
    throw new Error(
      `prediction verdict must be PASS or FAIL, got "${String(parsed.verdict)}"`,
    );
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Working-copy preparation (sandbox → gitignored copy under the repo)        */
/* -------------------------------------------------------------------------- */

/**
 * The vitest config written INSIDE the working copy. It is what makes the REAL
 * component render:
 *  - `@` → `<workingCopy>/src` matches the target's vite.config.ts / tsconfig
 *    `paths`, so `@/components/ui/*`, the `Book` service, etc. resolve against
 *    the working copy's own `node_modules` (installed fresh in the container);
 *  - `environment: "jsdom"` so `@testing-library/react` can render + query;
 *  - `include` points at exactly the dropped property file;
 *  - `globals: true` is harmless and keeps role queries / matchers working;
 *  - a `setupFiles` entry (see {@link WORKTREE_SETUP}) wires two interaction
 *    PLUMBING shims the real-DOM render needs (never touching the property's
 *    assertion): a `jest`-style fake-timer shim so `waitFor` cooperates with the
 *    property's `vi.useFakeTimers()`, and a `fireEvent.click` wrapper that emits
 *    the pointerdown/mousedown Radix Tabs requires to switch tabs;
 *  - the `@/integrations/supabase/client` alias points at an inert local stub so
 *    the component's module graph loads without a live backend. This mocks only
 *    the unrelated backend dependency — NOT the component under test or its
 *    ordering logic (the property still renders the real component and the FAIL
 *    comes from the real `getPeriods()`/`reverse()` bug).
 *
 * Note: this is emitted as a string so it can be written verbatim into the
 * working copy and picked up by the in-container Vitest (which auto-detects
 * `vitest.config.ts` and prefers it over the target's `vite.config.ts`).
 */
const WORKTREE_VITEST_CONFIG = `import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve paths relative to this config file so the working copy is relocatable.
const rootDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(rootDir, "src");

// Vitest config dropped into the writing-tracker WORKING COPY by the
// spec-lantern execute path (task 4.3). It renders the REAL
// PeriodProgressSummary component against the task-4.1 property.
export default defineConfig({
  resolve: {
    alias: [
      // Inert stub for the unrelated Supabase backend dependency so the
      // component's module graph loads without a live backend. This does NOT
      // mock the component under test. (The Book import is type-only and is
      // normally elided anyway; this is belt-and-suspenders.)
      {
        find: /^@\\/integrations\\/supabase\\/client$/,
        replacement: resolve(srcDir, "__spec_lantern__/supabase-stub.ts"),
      },
      // The project's own "@" -> src alias (must come AFTER the more specific
      // supabase alias so the specific rule wins).
      { find: /^@\\//, replacement: srcDir + "/" },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/__spec_lantern__/setup.ts"],
    include: ["src/__spec_lantern__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // The first container run installs React + Radix + the test toolchain; give
    // the single property generous headroom for its >=100 fast-check runs.
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
`;

/**
 * Setup file written INSIDE the working copy, wired via `setupFiles`. It patches
 * two interaction-PLUMBING gaps that only appear when rendering the REAL
 * component in jsdom. It never touches any property's assertion:
 *
 *  1. `waitFor` + fake timers. @testing-library's `waitFor` polls on real timers
 *     unless it detects a jest-style fake-timer global; the authored property
 *     pins the clock with `vi.useFakeTimers()`, which would otherwise freeze
 *     `waitFor`'s polling and hang the test. A minimal `jest` shim proxying
 *     `advanceTimersByTime` to `vi` lets `waitFor` drive the fake clock forward.
 *
 *  2. Radix Tabs activation. Radix UI Tabs switch on pointerdown/mousedown, not
 *     a bare synthetic `click`. The authored property uses `fireEvent.click` to
 *     select the "Monthly" tab; without the pointer events the tab never
 *     switches in jsdom. The shim makes `fireEvent.click` first dispatch the
 *     pointerdown/mousedown Radix listens for, exactly as a real pointer click
 *     (or `@testing-library/user-event`) would.
 */
const WORKTREE_SETUP = `import { vi } from "vitest";
import { fireEvent } from "@testing-library/react";

// (1) Make waitFor cooperate with Vitest fake timers.
(globalThis as unknown as { jest: unknown }).jest = {
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
};

// (2) Radix Tabs activate on pointerdown/mousedown, not a bare click.
const originalClick = fireEvent.click.bind(fireEvent);
fireEvent.click = ((element: Element | Node | Document | Window, init?: object) => {
  if (element instanceof Element) {
    fireEvent.pointerDown(element, init as never);
    fireEvent.mouseDown(element, init as never);
  }
  return originalClick(element as never, init as never);
}) as typeof fireEvent.click;
`;

/**
 * The inert Supabase client stub. Only has to satisfy the module graph if the
 * `Book` import ever becomes a value import; it never talks to a backend.
 */
const WORKTREE_SUPABASE_STUB = `// Inert Supabase client stub injected by the spec-lantern execute path
// (task 4.3). The real component only uses the backend's \`Book\` TYPE, so this
// is never actually called at runtime — it exists so the module graph resolves
// without a live backend. It does NOT alter the component's ordering logic.
export const supabase = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "spec-lantern stub: the Supabase backend is not available inside the " +
          "Isolated_Runner (the monthly-ordering property does not need it).",
      );
    },
  },
);
`;

/**
 * Copy the READ-ONLY writing-tracker source into a gitignored working copy under
 * the repo, excluding `node_modules`/`.git`/build output (the container installs
 * deps fresh), then drop the task-4.1 property file and the working-copy vitest
 * config into it. Returns the property file path RELATIVE to the working copy
 * (the runner treats a relative `propertyTestFile` as in-mount, so the file runs
 * in place from within the single mounted dir).
 *
 * sandbox/ is treated as immutable: we only ever read from it.
 */
async function prepareWorkingCopy(
  specRoot: string,
  targetSource: string,
  worktreeDir: string,
): Promise<{ propertyTestFile: string }> {
  const linkage = resolveClaimLinkage(
    specRoot,
    SKELETON_CLAIM_ID,
    SKELETON_PROPERTY_NUMBER,
  );

  // Fresh working copy every run — NEVER under /tmp (invisible in the macOS VM).
  await rm(worktreeDir, { recursive: true, force: true });
  await mkdir(worktreeDir, { recursive: true });

  // Copy sandbox/writing-tracker → working copy, excluding the heavy/irrelevant
  // dirs. node_modules is intentionally excluded so the container installs a
  // clean tree; copying it would be huge and slow. .git and build output are
  // irrelevant to the run.
  const excluded = new Set(["node_modules", ".git", "dist", "build"]);
  await cp(targetSource, worktreeDir, {
    recursive: true,
    filter: (source) => {
      // `source` is an absolute path inside targetSource; exclude a path if any
      // of its segments (relative to the source root) is in the excluded set.
      const relToSource = source.slice(targetSource.length).replace(/^[/\\]/, "");
      if (relToSource === "") return true;
      const segments = relToSource.split(/[/\\]/);
      return !segments.some((segment) => excluded.has(segment));
    },
  });

  // Drop the inert supabase stub + the task-4.1 property file into the working
  // copy under src/__spec_lantern__/ (covered by the "@" alias + include glob).
  const injectedDir = join(worktreeDir, "src", "__spec_lantern__");
  await mkdir(injectedDir, { recursive: true });
  await writeFile(join(injectedDir, "supabase-stub.ts"), WORKTREE_SUPABASE_STUB);
  await writeFile(join(injectedDir, "setup.ts"), WORKTREE_SETUP);
  await cp(linkage.propertyTestFile, join(worktreeDir, WORKTREE_PROPERTY_REL));

  // Write the working-copy vitest config at the working-copy root. Vitest
  // auto-detects `vitest.config.ts` and prefers it over the target's
  // `vite.config.ts` (which imports dev-only plugins we don't want in-container).
  await writeFile(join(worktreeDir, "vitest.config.ts"), WORKTREE_VITEST_CONFIG);

  return { propertyTestFile: WORKTREE_PROPERTY_REL };
}

/* -------------------------------------------------------------------------- */
/* Reusable working-copy seam (so other callers don't duplicate the setup)    */
/* -------------------------------------------------------------------------- */

/**
 * The propertyId the walking skeleton evaluates, surfaced so other callers (the
 * task 10.5 runner-dispatch smoke test) can build a request/runner call for the
 * SAME property the skeleton artifacts describe without re-deriving the stem.
 */
export const WALKING_SKELETON_PROPERTY_ID = SKELETON_PROPERTY_ID;

/** What {@link prepareWalkingSkeletonWorkingCopy} hands back to a caller. */
export interface PreparedWalkingSkeletonWorkingCopy {
  /** The gitignored working copy under the repo (the ONE dir to mount). */
  worktreeDir: string;
  /** The property test file path RELATIVE to the working copy (in-mount). */
  propertyTestFile: string;
  /** The property the working copy is set up to execute. */
  propertyId: string;
}

/**
 * Prepare the walking-skeleton writing-tracker WORKING COPY exactly the way
 * {@link executeWalkingSkeleton} does — copy `sandbox/writing-tracker` into a
 * gitignored, macOS-visible working copy (excluding `node_modules`/`.git`/build
 * output), drop the task-4.1 property file + the working-copy vitest config into
 * it — and return the one directory to mount, the in-mount property path, and
 * the propertyId.
 *
 * This is the SAME production preparation the skeleton execute path performs;
 * it is factored out so a caller that wants to dispatch the prepared copy
 * through a DIFFERENT seam (the orchestrator / the {@link IsolatedRunner}
 * contract — the task 10.5 smoke test) reuses the real setup instead of
 * duplicating it. The caller owns teardown of `worktreeDir`.
 */
export async function prepareWalkingSkeletonWorkingCopy(
  options: {
    specRoot?: string;
    targetSource?: string;
    worktreeDir?: string;
  } = {},
): Promise<PreparedWalkingSkeletonWorkingCopy> {
  const specRoot = options.specRoot ?? DEFAULT_SPEC_ROOT;
  const targetSource = options.targetSource ?? DEFAULT_TARGET_SOURCE;
  const worktreeDir = options.worktreeDir ?? makeUniqueWorktreeDir();
  const { propertyTestFile } = await prepareWorkingCopy(
    specRoot,
    targetSource,
    worktreeDir,
  );
  return { worktreeDir, propertyTestFile, propertyId: SKELETON_PROPERTY_ID };
}

/** The default read-only source Target_Repo the walking skeleton copies from. */
export const WALKING_SKELETON_TARGET_SOURCE = DEFAULT_TARGET_SOURCE;

/* -------------------------------------------------------------------------- */
/* The execute path                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Run the thinnest execute path end-to-end and surface the contradiction.
 *
 * Loads the task-4.1 artifacts, reads the PASS prediction, copies the REAL
 * writing-tracker into a gitignored working copy, dispatches the ONE property
 * into the task-4.2 rootless-Podman runner (rendering the REAL
 * PeriodProgressSummary component INSIDE the container), then compares the
 * executed `ActualResult` against the prediction and reports the mismatch.
 *
 * This never runs target code on the host: all execution happens via
 * `runTwoPhase` (install phase + no-network test phase), which returns
 * `RUNNER_UNAVAILABLE` rather than falling back to the host when Podman is
 * absent.
 */
export async function executeWalkingSkeleton(
  options: ExecuteWalkingSkeletonOptions = {},
): Promise<WalkingSkeletonOutcome> {
  const specRoot = options.specRoot ?? DEFAULT_SPEC_ROOT;
  const targetSource = options.targetSource ?? DEFAULT_TARGET_SOURCE;
  const worktreeDir = options.worktreeDir ?? makeUniqueWorktreeDir();
  const timeoutSeconds = options.timeoutSeconds ?? 600;
  const log = options.log ?? (() => undefined);

  // 1. Load the comment-trusting prediction (read-only, pre-execution).
  log(`Loading task-4.1 artifacts for ${SKELETON_PROPERTY_ID} from ${specRoot}`);
  const predicted = await loadPrediction(specRoot);
  log(`Comment-trusting Predicted_Result: ${predicted.verdict}`);

  try {
    // 2. Copy sandbox/writing-tracker → gitignored working copy (macOS-safe),
    //    excluding node_modules; drop the property + vitest config into it.
    log(
      `Copying read-only target ${targetSource} → working copy ${worktreeDir} ` +
        `(excluding node_modules/.git/build)`,
    );
    const { propertyTestFile } = await prepareWorkingCopy(
      specRoot,
      targetSource,
      worktreeDir,
    );

    // 3. Dispatch the ONE property through the task-9 two-phase runner. ONLY
    //    the working copy is mounted; the install happens in the internal-
    //    network+Verdaccio phase and the REAL component renders in the
    //    `--network none` test phase — both inside rootless Podman, never on
    //    the host.
    log(
      "Dispatching the property through the two-phase runner " +
        "(install via the internal network + Verdaccio proxy, then test with " +
        "--network none)…",
    );
    const actual = await runTwoPhase({
      propertyId: SKELETON_PROPERTY_ID,
      targetRepoPath: worktreeDir,
      propertyTestFile,
      // The no-network Test_Execution_Phase per-run timeout. The install phase
      // has its own (generous) timeout; see `install` below.
      timeoutSeconds,
      // Phase one installs the target's deps AND the pinned test toolchain
      // through the Verdaccio proxy. Installing React + Radix + testing-library
      // through a cold proxy is the slow part, so give it the generous ceiling
      // the single-container path used to spend on its combined install+test.
      install: { timeoutSeconds },
    });
    log(`Runner returned outcome: ${actual.outcome}`);

    // 4. Compare the executed result against the prediction and surface it.
    return surfaceOutcome(predicted, actual);
  } finally {
    // 5. Clean up the working copy so nothing leaks between runs (unless the
    //    caller asked to keep it for debugging).
    if (!options.keepWorktree) {
      await rm(worktreeDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

/**
 * Build the surfaced {@link WalkingSkeletonOutcome} from a prediction and an
 * executed actual result, making the predicted-vs-actual contradiction
 * explicit. A mismatch is flagged ONLY when the run produced a verdict (closed-
 * union discipline: timeouts / errors / unavailability are never compared as if
 * they were PASS/FAIL — that nuance is the Comparison Engine's job in task 14,
 * but even the skeleton must not pretend a non-verdict is a FAIL).
 */
export function surfaceOutcome(
  predicted: PredictedResult,
  actual: ActualResult,
): WalkingSkeletonOutcome {
  const predictedVerdict = predicted.verdict;
  const actualVerdict =
    actual.outcome === "VERDICT" ? actual.verdict : null;
  const predictionContradicted =
    actualVerdict !== null && actualVerdict !== predictedVerdict;

  let summary: string;
  if (actualVerdict === null) {
    summary =
      `Property ${predicted.propertyId}: predicted ${predictedVerdict}, but ` +
      `execution produced no verdict (${actual.outcome}` +
      ("reason" in actual ? `: ${actual.reason}` : "") +
      `). No comparison made.`;
  } else if (predictionContradicted) {
    const cx =
      actual.outcome === "VERDICT" && actual.counterexample
        ? ` Counterexample: input=${stringifyCompact(
            actual.counterexample.input,
          )} observedOutput=${stringifyCompact(
            actual.counterexample.observedOutput,
          )}`
        : "";
    summary =
      `CONTRADICTION — the comment-trusting prediction said ` +
      `${predictedVerdict}, but executing property ${predicted.propertyId} ` +
      `against writing-tracker produced ${actualVerdict}.${cx}`;
  } else {
    summary =
      `Property ${predicted.propertyId}: execution (${actualVerdict}) agrees ` +
      `with the prediction (${predictedVerdict}).`;
  }

  return {
    propertyId: predicted.propertyId,
    predicted,
    actual,
    predictedVerdict,
    actualVerdict,
    predictionContradicted,
    summary,
  };
}

/** Compact one-line stringification for surfacing counterexample values. */
function stringifyCompact(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 300);
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? String(value);
  } catch {
    return String(value);
  }
}
