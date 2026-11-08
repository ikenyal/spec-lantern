/**
 * Pure core of the report-sections generator — the testable logic that builds
 * the "Behind the lantern" timelines, the "How it stays safe" isolation model,
 * and the "We hold ourselves to the same standard" items.
 *
 * It is PURE w.r.t. the environment: all I/O goes through injected
 * {@link TimelineReaders}, so the tests (generate-timeline.test.ts) drive it
 * with in-memory fixtures — no filesystem, no git. The thin CLI
 * (generate-timeline.ts) wires in the real `fs` + `git`.
 *
 * DATA FIDELITY (.kiro/steering/report-data-fidelity.md). Nothing here is
 * hand-typed from memory. Every timeline fact is read at build time from one of
 * three real sources: `git log` (commit short hash + subject + date of each
 * phase), `locks/*.lock.json` `lockedAt` (when predictions were locked), and
 * `results/**` `capturedAt` (when execution / replay / the fix ran). The
 * headline claim — predictions were committed to git BEFORE any execution — is
 * COMPUTED by comparing the earliest `lockedAt` to the earliest execution
 * `capturedAt`, never asserted by hand.
 */
import { join } from "node:path";
import {
  GITHUB_COMMIT_BASE,
  commitUrl,
  type HarnessRevisionTiming,
  type HarnessRevisions,
  type HonestyItem,
  type IsolationModel,
  type ReportSectionsAsset,
  type TargetTimeline,
  type TimelineStep,
  type VerdictMismatch,
} from "../src/report-asset.js";

/* -------------------------------------------------------------------------- */
/* Injected-reader seams (so the core is testable without fs/git)             */
/* -------------------------------------------------------------------------- */

/** One commit as read from `git log`. */
export interface CommitInfo {
  readonly shortHash: string;
  readonly subject: string;
  /** ISO commit date. */
  readonly date: string;
}

/** The side-effecting readers the generator depends on, injectable for tests. */
export interface TimelineReaders {
  /** Read a UTF-8 file's contents by absolute path. */
  readFile(path: string): Promise<string>;
  /** List the file names directly inside a directory. */
  listDir(path: string): Promise<readonly string[]>;
  /**
   * The git commit that ADDED a given path (first commit with `--diff-filter=A`
   * touching it), or `null` when none is found. Must return the short hash,
   * subject, and ISO date.
   */
  firstCommitForPath(repoRelPath: string): Promise<CommitInfo | null>;
  /**
   * The MOST RECENT git commit that touched a given path (the latest commit in
   * `git log -- <path>`), or `null` when none is found. Used to find the commit
   * that last CHANGED the `locks/` directory (the re-lock), as opposed to the
   * one that first added it.
   */
  lastCommitForPath(repoRelPath: string): Promise<CommitInfo | null>;
  /** Resolve a commit-ish to its short hash + subject + date, or null. */
  resolveCommit(commitish: string): Promise<CommitInfo | null>;
}

/** Describes one target's on-disk layout under the skeleton root. */
export interface TargetSource {
  readonly id: string;
  readonly label: string;
  /** Absolute path to the target's skeleton directory. */
  readonly rootAbs: string;
  /** Repo-relative path to the target's skeleton directory (for git). */
  readonly rootRel: string;
  /**
   * The lock file whose add-commit is the "lock commit" and whose `lockedAt`
   * anchors "predictions locked" (name under `locks/`).
   */
  readonly anchorLockName: string;
  /** The stage-c result file that anchors "execution" (name under results/stage-c/). */
  readonly executionResultName: string;
  /** A replay result file name under results/stage-c/ (the "replay reproduced" anchor). */
  readonly replayResultName: string;
  /**
   * The stage-d result file where the fix was FIRST applied (anchors the "fix"
   * step). Its first-add commit is when the fix first landed — distinct from
   * the regression result, which may be a later file/commit.
   */
  readonly fixResultName: string;
  /**
   * The stage-d result file where the full regression re-run was recorded
   * (anchors the "regression check" step). May equal {@link fixResultName} for
   * a target that recorded the fix and regression in one file; when distinct,
   * each step derives its commit from its OWN file's first-add commit.
   */
  readonly regressionResultName: string;
  /**
   * When the test-harness revisions happened relative to execution — a prose
   * fact recorded VERBATIM in this target's `locks/superseded/README.md`, which
   * timestamps alone cannot establish (a re-lock can predate the persisted
   * single-source execution run even when a FIRST run already exposed the
   * defect). Carried here with a `timingNote` and the README link so the reader
   * can verify it against the source. Omitted for a target with no superseded
   * locks.
   */
  readonly harnessRevisionTiming?: HarnessRevisionTiming;
  /** One-line, README-sourced statement of that timing for display. */
  readonly harnessRevisionTimingNote?: string;
}

/* -------------------------------------------------------------------------- */
/* Small parse helpers (verbatim reads, never fabrication)                    */
/* -------------------------------------------------------------------------- */

/** The fields the generator reads out of a Prediction_Lock file. */
interface LockFields {
  readonly propertyId: string;
  readonly verdict: string;
  readonly lockedAt: string;
  readonly contentHash?: string;
}

/** Parse the fields the generator needs out of a lock file's JSON. */
function parseLock(json: string): LockFields {
  const obj = JSON.parse(json) as Record<string, unknown>;
  if (typeof obj.lockedAt !== "string") {
    throw new Error("lock file has no string lockedAt");
  }
  if (typeof obj.propertyId !== "string") {
    throw new Error("lock file has no string propertyId");
  }
  if (typeof obj.verdict !== "string") {
    throw new Error("lock file has no string verdict");
  }
  return {
    propertyId: obj.propertyId,
    verdict: obj.verdict,
    lockedAt: obj.lockedAt,
    contentHash:
      typeof obj.contentHash === "string" ? obj.contentHash : undefined,
  };
}

/** Parse the `capturedAt` ISO string out of a result file's JSON. */
function parseCapturedAt(json: string): string {
  const obj = JSON.parse(json) as { capturedAt?: unknown };
  if (typeof obj.capturedAt !== "string") {
    throw new Error("result file has no string capturedAt");
  }
  return obj.capturedAt;
}

/** Parse `reproducesSameFail` out of a replay result file's JSON. */
function parseReproduces(json: string): boolean {
  const obj = JSON.parse(json) as { reproducesSameFail?: unknown };
  return obj.reproducesSameFail === true;
}

/** The earliest instant among ISO strings, or undefined when empty. */
function earliest(isoTimes: readonly string[]): string | undefined {
  let min: string | undefined;
  for (const t of isoTimes) {
    if (min === undefined || Date.parse(t) < Date.parse(min)) min = t;
  }
  return min;
}

/** The latest instant among ISO strings, or undefined when empty. */
function latest(isoTimes: readonly string[]): string | undefined {
  let max: string | undefined;
  for (const t of isoTimes) {
    if (max === undefined || Date.parse(t) > Date.parse(max)) max = t;
  }
  return max;
}

/**
 * Read every `*.lock.json` lock in a directory (ignoring other files), via the
 * injected reader. Returns the parsed {@link LockFields} for each.
 */
async function readLocksInDir(
  readers: TimelineReaders,
  dirAbs: string,
): Promise<readonly LockFields[]> {
  let names: readonly string[];
  try {
    names = (await readers.listDir(dirAbs)).filter((n) =>
      n.endsWith(".lock.json"),
    );
  } catch {
    // No such directory (e.g. no superseded/) -> no locks.
    return [];
  }
  const locks: LockFields[] = [];
  for (const name of names) {
    locks.push(parseLock(await readers.readFile(join(dirAbs, name))));
  }
  return locks;
}

/**
 * Flag any superseded lock whose verdict differs from the ACTIVE lock's verdict
 * for the same property. A re-lock may only change the hashed property source,
 * never the predicted verdict — so a non-empty result is a data-integrity flag.
 * A superseded property with no active counterpart is also flagged (its active
 * verdict reads as "(none)").
 */
export function findVerdictMismatches(
  active: readonly LockFields[],
  superseded: readonly LockFields[],
): VerdictMismatch[] {
  const activeByProp = new Map(active.map((l) => [l.propertyId, l.verdict]));
  const mismatches: VerdictMismatch[] = [];
  for (const s of superseded) {
    const activeVerdict = activeByProp.get(s.propertyId);
    if (activeVerdict !== s.verdict) {
      mismatches.push({
        propertyId: s.propertyId,
        activeVerdict: activeVerdict ?? "(none)",
        supersededVerdict: s.verdict,
      });
    }
  }
  return mismatches;
}

/* -------------------------------------------------------------------------- */
/* Per-target timeline                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build one target's "Behind the lantern" timeline by READING its lock files,
 * result files, and the git commits that added them. Returns the ordered steps
 * plus the computed `predictionsLockedBeforeExecution` flag.
 */
export async function buildTargetTimeline(
  readers: TimelineReaders,
  target: TargetSource,
): Promise<TargetTimeline> {
  const locksDirAbs = join(target.rootAbs, "locks");
  const supersededDirAbs = join(locksDirAbs, "superseded");
  const stageCAbs = join(target.rootAbs, "results", "stage-c");

  // 1. Predictions locked. Read ALL active locks; the headline claim uses the
  //    LATEST active lockedAt (so it holds only if EVERY active prediction was
  //    locked before execution), while the step time shows the earliest.
  const activeLocks = await readLocksInDir(readers, locksDirAbs);
  const lockedAts = activeLocks.map((l) => l.lockedAt);
  const earliestLockedAt = earliest(lockedAts);
  const latestLockedAt = latest(lockedAts);

  // The lock short hash shown as the "predictions locked" detail: the anchor
  // lock's contentHash, read verbatim from the file (first 12 chars).
  const anchorLock = parseLock(
    await readers.readFile(join(locksDirAbs, target.anchorLockName)),
  );
  const lockShortHash = anchorLock.contentHash?.slice(0, 12);

  // Verdict-equality check: every superseded lock's verdict must equal the
  // active lock's verdict for the same property (a re-lock never changes the
  // predicted verdict). Surfaced, never hidden.
  const supersededLocks = await readLocksInDir(readers, supersededDirAbs);
  const verdictMismatches = findVerdictMismatches(activeLocks, supersededLocks);

  // 1a. Predictions FIRST locked — the git commit that first ADDED the lock
  //     directory (via the anchor lock file's first-add commit).
  const firstLockCommit = await readers.firstCommitForPath(
    `${target.rootRel}/locks/${target.anchorLockName}`,
  );
  // 1b. FINAL locks — the git commit that LAST changed the locks/ directory
  //     (the most recent commit touching it; a re-lock, if any). The
  //     locked-before-execution claim is computed from the latest active lock,
  //     so this is the commit that commit corresponds to.
  const finalLockCommit = await readers.lastCommitForPath(
    `${target.rootRel}/locks/`,
  );

  // 2. Execution — capturedAt of the stage-c execution result + its add-commit.
  const executionRel = `${target.rootRel}/results/stage-c/${target.executionResultName}`;
  const executionCapturedAt = parseCapturedAt(
    await readers.readFile(join(stageCAbs, target.executionResultName)),
  );
  const executionCommit = await readers.firstCommitForPath(executionRel);

  // 3. Replay reproduced — capturedAt + reproducesSameFail of the replay file.
  const replayJson = await readers.readFile(
    join(stageCAbs, target.replayResultName),
  );
  const replayCapturedAt = parseCapturedAt(replayJson);
  const replayReproduced = parseReproduces(replayJson);

  // 4. Fix — the commit that FIRST applied the fix (the fix result file's
  //    first-add commit), with that file's capturedAt. Distinct from the
  //    regression file when the two were recorded separately.
  const stageDAbs = join(target.rootAbs, "results", "stage-d");
  const fixRel = `${target.rootRel}/results/stage-d/${target.fixResultName}`;
  const fixCapturedAt = parseCapturedAt(
    await readers.readFile(join(stageDAbs, target.fixResultName)),
  );
  const fixCommit = await readers.firstCommitForPath(fixRel);

  // 5. Regression check — the commit that first recorded the regression re-run
  //    result (its own file's first-add commit), with that file's capturedAt.
  const regressionRel = `${target.rootRel}/results/stage-d/${target.regressionResultName}`;
  const regressionCapturedAt = parseCapturedAt(
    await readers.readFile(join(stageDAbs, target.regressionResultName)),
  );
  const regressionCommit = await readers.firstCommitForPath(regressionRel);

  const steps: TimelineStep[] = [
    {
      phase: "predictions-first-locked",
      label: "Predictions first locked",
      at: earliestLockedAt,
      commit: firstLockCommit?.shortHash,
      commitSubject: firstLockCommit?.subject,
      detail: lockShortHash ? `lock hash ${lockShortHash}` : undefined,
    },
    {
      phase: "final-locks",
      label: "Final locks",
      at: latestLockedAt,
      commit: finalLockCommit?.shortHash,
      commitSubject: finalLockCommit?.subject,
    },
    {
      phase: "execution",
      label: "Executed in the isolated runner",
      at: executionCapturedAt,
      commit: executionCommit?.shortHash,
      commitSubject: executionCommit?.subject,
    },
    {
      phase: "replay-reproduced",
      label: "Counterexample replayed",
      at: replayCapturedAt,
      detail: replayReproduced
        ? "same failure reproduced (reproducesSameFail: true)"
        : "replay did not reproduce",
    },
    {
      phase: "fix",
      label: "Fix applied to a throwaway copy",
      at: fixCapturedAt,
      commit: fixCommit?.shortHash,
      commitSubject: fixCommit?.subject,
    },
    {
      phase: "regression-check",
      label: "All properties re-run (regression check)",
      at: regressionCapturedAt,
      commit: regressionCommit?.shortHash,
      commitSubject: regressionCommit?.subject,
    },
  ];

  // The headline point, COMPUTED and TIGHTENED: the LATEST active lock precedes
  // the execution — i.e. EVERY predicted verdict was locked before any run.
  // Using the latest (not earliest) means a single late re-lock after execution
  // flips this to false, as it should.
  const predictionsLockedBeforeExecution =
    latestLockedAt !== undefined &&
    Date.parse(latestLockedAt) < Date.parse(executionCapturedAt);

  // Harness revisions — present only when there are superseded locks. Reported
  // SEPARATELY from the prediction-lock claim. Its timing relative to execution
  // is the README-sourced prose fact on the target (see TargetSource), not a
  // timestamp inference.
  const harnessRevisions: HarnessRevisions | undefined =
    supersededLocks.length > 0 && target.harnessRevisionTiming
      ? {
          count: supersededLocks.length,
          timing: target.harnessRevisionTiming,
          timingNote:
            target.harnessRevisionTimingNote ??
            (target.harnessRevisionTiming === "before-any-execution"
              ? "revised and re-locked before any execution"
              : "revised and re-locked after a first run exposed the harness defects"),
          readmePath: `${target.rootRel}/locks/superseded/README.md`,
        }
      : undefined;

  return {
    id: target.id,
    label: target.label,
    steps,
    predictionsLockedBeforeExecution,
    verdictMismatches,
    harnessRevisions,
  };
}

/* -------------------------------------------------------------------------- */
/* "How it stays safe" — described from the runner source                     */
/* -------------------------------------------------------------------------- */

/**
 * The two-phase isolation model. Each line describes what the runner source
 * ACTUALLY does and names the file it is enforced in (traceability). The text
 * is deliberately conservative — it only states guarantees present in the
 * source read while authoring this (install-phase.ts, test-phase.ts,
 * safety-gate/index.ts, revive/apply-fixes.ts).
 */
export const ISOLATION_MODEL: IsolationModel = {
  phases: [
    {
      id: "install",
      title: "Install phase",
      summary:
        "Dependencies install on an internal-only Podman network with no direct route to the internet.",
      guarantees: [
        {
          text:
            "The install container sits on an --internal network; its only reachable peer is a Verdaccio registry proxy.",
          source: "packages/mcp-server/src/runner/install-phase.ts",
        },
        {
          text:
            "The Verdaccio proxy is the single outbound-capable container — the one bridge to the real registry.",
          source: "packages/mcp-server/src/runner/install-phase.ts",
        },
        {
          text:
            "Packages install with --ignore-scripts, so no lifecycle script runs.",
          source: "packages/mcp-server/src/runner/install-phase.ts",
        },
        {
          text:
            "The install topology (both networks + proxy) is torn down before the test phase begins.",
          source: "packages/mcp-server/src/runner/install-phase.ts",
        },
      ],
    },
    {
      id: "test",
      title: "Test phase",
      summary:
        "Property tests run with no network at all; the deps were already on disk from the install phase.",
      guarantees: [
        {
          text:
            "The test container runs with --network none: an empty network namespace, loopback only, no route out.",
          source: "packages/mcp-server/src/runner/test-phase.ts",
        },
        {
          text:
            "npx --no-install is used, so the runner never reaches for a registry during the test phase.",
          source: "packages/mcp-server/src/runner/test-phase.ts",
        },
        {
          text:
            "Only the one target working directory is bind-mounted into the container (boundary confinement).",
          source: "packages/mcp-server/src/runner/test-phase.ts",
        },
      ],
    },
  ],
  crossCutting: [
    {
      text:
        "The Safety Gate classifies every request BEFORE anything runs and refuses any host-execution directive; it never accepts a host target.",
      source: "packages/mcp-server/src/safety-gate/index.ts",
    },
    {
      text:
        "If Podman is unavailable the runner returns RUNNER_UNAVAILABLE — it never falls back to running target code on the host.",
      source: "packages/mcp-server/src/runner/test-phase.ts",
    },
    {
      text:
        "Fixes are written only to a throwaway copy of the target; the original repo is never opened for writing.",
      source: "packages/mcp-server/src/revive/apply-fixes.ts",
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* "We hold ourselves to the same standard" — commit hashes resolved from git */
/* -------------------------------------------------------------------------- */

/**
 * The commit that fixed a bypass found in spec-lantern's OWN Safety Gate by its
 * property test. Resolved from git at build time so the short hash and subject
 * are real, not transcribed.
 */
export const SAFETY_GATE_FIX_COMMITISH = "70d61ad";

/**
 * Build the honesty items. The Safety-Gate item's commit is resolved from git
 * so the hash + subject are verified real; the writing-tracker and MoodPlays
 * items link to the superseded-lock READMEs (repo-relative file paths), which
 * record the test-harness-defect and tautological-oracle episodes verbatim.
 */
export async function buildHonestyItems(
  readers: TimelineReaders,
): Promise<readonly HonestyItem[]> {
  const gateFix = await readers.resolveCommit(SAFETY_GATE_FIX_COMMITISH);
  const gateHash = gateFix?.shortHash ?? SAFETY_GATE_FIX_COMMITISH;

  return [
    {
      title: "Our own Safety Gate had a bypass — our property test caught it",
      body:
        "A spec-lantern property test found that the Safety Gate matched host-command prefixes loosely, so some host directives could slip through. We fixed it to match whole tokens.",
      linkLabel: gateHash,
      href: commitUrl(gateHash),
    },
    {
      title: "writing-tracker: two failures were test-harness defects, not bugs",
      body:
        "Two properties failed on our own test harness (a brittle DOM lookup and a trim mismatch), not on the target. We did not report them as bugs; the original locks moved to superseded with a written note.",
      linkLabel: "writing-tracker-full/locks/superseded/README.md",
      href: "packages/mcp-server/skeleton/writing-tracker-full/locks/superseded/README.md",
    },
    {
      title: "MoodPlays: 5 of Kiro's first 10 properties restated the code",
      body:
        "Five of the first ten properties checked the code against an oracle that mirrored the implementation. We rewrote them with independent oracles BEFORE any execution, and superseded the old locks.",
      linkLabel: "moodplays/locks/superseded/README.md",
      href: "packages/mcp-server/skeleton/moodplays/locks/superseded/README.md",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the full {@link ReportSectionsAsset} from the injected readers and
 * the target sources. Pure w.r.t. the environment: all I/O goes through
 * `readers`, so a test can drive it with in-memory fixtures.
 */
export async function buildSectionsAsset(
  readers: TimelineReaders,
  targets: readonly TargetSource[],
  now: () => Date = () => new Date(),
): Promise<ReportSectionsAsset> {
  const timelines: TargetTimeline[] = [];
  for (const target of targets) {
    timelines.push(await buildTargetTimeline(readers, target));
  }
  const honesty = await buildHonestyItems(readers);
  return {
    generatedAt: now().toISOString(),
    commitBase: GITHUB_COMMIT_BASE,
    timelines,
    isolation: ISOLATION_MODEL,
    honesty,
  };
}
