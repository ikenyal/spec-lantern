/**
 * Tests for the report-sections generator core (../scripts/timeline-core.ts).
 *
 * The generator reads three REAL sources — `git log`, `locks/*.lock.json`
 * `lockedAt`, and `results/**` `capturedAt` — and emits the "Behind the
 * lantern" timelines, the "How it stays safe" isolation model, and the "We
 * hold ourselves to the same standard" items. These tests drive the PURE core
 * with injected in-memory readers (no filesystem, no git), so they assert the
 * generator's logic deterministically:
 *
 *   - the six timeline steps come out in order, each sourced from the right
 *     file / commit;
 *   - `predictionsLockedBeforeExecution` is COMPUTED as `latest active lockedAt
 *     < earliest execution capturedAt` — true only when EVERY active prediction
 *     was locked before execution, false when any re-lock lands after it;
 *   - every superseded lock's verdict must equal the active lock's verdict for
 *     the same property; a mismatch is flagged;
 *   - commit short hashes + subjects come from the injected git reader;
 *   - the replay step reflects `reproducesSameFail`;
 *   - the honesty items resolve the Safety-Gate commit from git and link the
 *     two superseded-lock READMEs by repo-relative path.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  buildSectionsAsset,
  buildTargetTimeline,
  buildHonestyItems,
  SAFETY_GATE_FIX_COMMITISH,
  type CommitInfo,
  type TargetSource,
  type TimelineReaders,
} from "../scripts/timeline-core.js";
import { GITHUB_COMMIT_BASE } from "./report-asset.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const TARGET: TargetSource = {
  id: "demo",
  label: "Demo",
  rootAbs: "/abs/demo",
  rootRel: "rel/demo",
  anchorLockName: "property-1.lock.json",
  executionResultName: "exec-all.json",
  replayResultName: "replay-1.json",
  fixResultName: "fix.json",
  regressionResultName: "fix-all.json",
};

const locksDir = join(TARGET.rootAbs, "locks");
const supersededDir = join(locksDir, "superseded");
const stageCDir = join(TARGET.rootAbs, "results", "stage-c");
const stageDDir = join(TARGET.rootAbs, "results", "stage-d");

/** Serialize a minimal lock file body. */
function lock(
  propertyId: string,
  verdict: string,
  lockedAt: string,
  contentHash = "abcdef0123456789aaaa",
): string {
  return JSON.stringify({ propertyId, verdict, lockedAt, contentHash });
}

/** A reader backed by in-memory file + git maps. */
function makeReaders(opts: {
  files: Record<string, string>;
  dirs: Record<string, readonly string[]>;
  adds?: Record<string, CommitInfo>;
  lastCommits?: Record<string, CommitInfo>;
  resolves?: Record<string, CommitInfo>;
}): TimelineReaders {
  return {
    async readFile(path) {
      if (path in opts.files) return opts.files[path];
      throw new Error(`no such file: ${path}`);
    },
    async listDir(path) {
      if (path in opts.dirs) return opts.dirs[path];
      throw new Error(`no such dir: ${path}`);
    },
    async firstCommitForPath(repoRelPath) {
      return opts.adds?.[repoRelPath] ?? null;
    },
    async lastCommitForPath(repoRelPath) {
      return opts.lastCommits?.[repoRelPath] ?? null;
    },
    async resolveCommit(commitish) {
      return opts.resolves?.[commitish] ?? null;
    },
  };
}

/**
 * The standard happy-path fixture. Two active locks; the LATEST of them
 * (`property-2` at +06:00) still precedes execution, so the tightened claim is
 * true. Optional superseded locks exercise the harness-revision + verdict
 * checks.
 */
function standardReaders(opts?: {
  /** Active lock for property-1 (the anchor). */
  p1LockedAt?: string;
  /** Active lock for property-2 (the LATEST active lock in the fixture). */
  p2LockedAt?: string;
  executionCapturedAt?: string;
  /** Superseded lock names under superseded/. */
  supersededNames?: readonly string[];
  /** Superseded lock bodies keyed by name. */
  supersededFiles?: Record<string, string>;
}): TimelineReaders {
  const p1LockedAt = opts?.p1LockedAt ?? "2026-01-01T00:00:00.000Z";
  const p2LockedAt = opts?.p2LockedAt ?? "2026-01-01T06:00:00.000Z";
  const executionCapturedAt =
    opts?.executionCapturedAt ?? "2026-01-02T00:00:00.000Z";

  const dirs: Record<string, readonly string[]> = {
    [locksDir]: ["property-1.lock.json", "property-2.lock.json", "notes.txt"],
  };
  const files: Record<string, string> = {
    [join(locksDir, "property-1.lock.json")]: lock(
      "property-1",
      "PASS",
      p1LockedAt,
    ),
    [join(locksDir, "property-2.lock.json")]: lock(
      "property-2",
      "PASS",
      p2LockedAt,
      "ffff",
    ),
    [join(stageCDir, "exec-all.json")]: JSON.stringify({
      capturedAt: executionCapturedAt,
    }),
    [join(stageCDir, "replay-1.json")]: JSON.stringify({
      capturedAt: "2026-01-02T00:05:00.000Z",
      reproducesSameFail: true,
    }),
    // The fix was FIRST applied here (its own file + commit) …
    [join(stageDDir, "fix.json")]: JSON.stringify({
      capturedAt: "2026-01-03T00:00:00.000Z",
    }),
    // … and the regression re-run recorded separately, later.
    [join(stageDDir, "fix-all.json")]: JSON.stringify({
      capturedAt: "2026-01-04T00:00:00.000Z",
    }),
  };

  if (opts?.supersededNames) {
    dirs[supersededDir] = opts.supersededNames;
    for (const name of opts.supersededNames) {
      files[join(supersededDir, name)] = opts.supersededFiles?.[name] ?? "";
    }
  }

  return makeReaders({
    dirs,
    files,
    adds: {
      // First-add of the anchor lock -> "predictions first locked" commit.
      "rel/demo/locks/property-1.lock.json": {
        shortHash: "aaa1111",
        subject: "lock predictions (first)",
        date: "2026-01-01T09:00:00+09:00",
      },
      "rel/demo/results/stage-c/exec-all.json": {
        shortHash: "bbb2222",
        subject: "persist execution results",
        date: "2026-01-02T09:00:00+09:00",
      },
      // First-add of the FIX file -> "fix applied" commit.
      "rel/demo/results/stage-d/fix.json": {
        shortHash: "ddd4444",
        subject: "fix on copy",
        date: "2026-01-03T09:00:00+09:00",
      },
      // First-add of the REGRESSION file -> "regression check" commit (distinct).
      "rel/demo/results/stage-d/fix-all.json": {
        shortHash: "eee5555",
        subject: "regression re-run",
        date: "2026-01-04T09:00:00+09:00",
      },
    },
    lastCommits: {
      // Last change to locks/ -> "final locks" commit (a re-lock).
      "rel/demo/locks/": {
        shortHash: "fff6666",
        subject: "re-lock after harness revision",
        date: "2026-01-01T12:00:00+09:00",
      },
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Timeline                                                                   */
/* -------------------------------------------------------------------------- */

describe("buildTargetTimeline", () => {
  it("emits the six phases in order", async () => {
    const t = await buildTargetTimeline(standardReaders(), TARGET);
    expect(t.steps.map((s) => s.phase)).toEqual([
      "predictions-first-locked",
      "final-locks",
      "execution",
      "replay-reproduced",
      "fix",
      "regression-check",
    ]);
  });

  it("shows BOTH the first lock (earliest lockedAt + first add-commit) and the final locks (latest lockedAt + last locks/ commit)", async () => {
    const t = await buildTargetTimeline(standardReaders(), TARGET);
    const byPhase = Object.fromEntries(t.steps.map((s) => [s.phase, s]));

    // First lock: earliest active lockedAt (property-1 @00:00) + the commit
    // that first ADDED the locks (the anchor lock's first-add commit).
    const first = byPhase["predictions-first-locked"];
    expect(first.at).toBe("2026-01-01T00:00:00.000Z");
    expect(first.commit).toBe("aaa1111");
    expect(first.commitSubject).toMatch(/first/);
    expect(first.detail).toBe("lock hash abcdef012345");

    // Final locks: latest active lockedAt (property-2 @06:00) + the commit that
    // LAST changed locks/ (the re-lock). The locked-before claim uses this.
    const final = byPhase["final-locks"];
    expect(final.at).toBe("2026-01-01T06:00:00.000Z");
    expect(final.commit).toBe("fff6666");
    expect(final.commitSubject).toMatch(/re-lock/);
  });

  it("derives fix and regression from their OWN first-add commits (distinct files)", async () => {
    const t = await buildTargetTimeline(standardReaders(), TARGET);
    const byPhase = Object.fromEntries(t.steps.map((s) => [s.phase, s]));
    expect(byPhase["execution"].commit).toBe("bbb2222");
    // Fix step -> first-add of fix.json (not the regression file).
    expect(byPhase["fix"].commit).toBe("ddd4444");
    expect(byPhase["fix"].at).toBe("2026-01-03T00:00:00.000Z");
    // Regression step -> first-add of fix-all.json (a later, separate commit).
    expect(byPhase["regression-check"].commit).toBe("eee5555");
    expect(byPhase["regression-check"].at).toBe("2026-01-04T00:00:00.000Z");
  });

  it("reflects reproducesSameFail on the replay step", async () => {
    const t = await buildTargetTimeline(standardReaders(), TARGET);
    const replay = t.steps.find((s) => s.phase === "replay-reproduced")!;
    expect(replay.at).toBe("2026-01-02T00:05:00.000Z");
    expect(replay.detail).toMatch(/reproduced/);
  });

  it("predictionsLockedBeforeExecution = true only when EVERY active lock precedes execution", async () => {
    // Both active locks (p1 @00:00, p2 @06:00) precede execution @ day 2.
    const t = await buildTargetTimeline(standardReaders(), TARGET);
    expect(t.predictionsLockedBeforeExecution).toBe(true);
  });

  it("uses the LATEST active lock, not the earliest: a re-lock after execution flips it to false", async () => {
    // p1 was locked well before execution, but p2 was RE-LOCKED after it.
    // Using the earliest lock would wrongly report true; the tightened claim
    // (latest active lock < execution) must be FALSE.
    const readers = standardReaders({
      p1LockedAt: "2026-01-01T00:00:00.000Z", // before execution
      p2LockedAt: "2026-01-02T12:00:00.000Z", // AFTER execution
      executionCapturedAt: "2026-01-02T00:00:00.000Z",
    });
    const t = await buildTargetTimeline(readers, TARGET);
    expect(t.predictionsLockedBeforeExecution).toBe(false);
  });

  it("computes false when execution precedes all locks", async () => {
    const readers = standardReaders({
      p1LockedAt: "2026-02-01T00:00:00.000Z",
      p2LockedAt: "2026-02-01T06:00:00.000Z",
      executionCapturedAt: "2026-01-01T00:00:00.000Z",
    });
    const t = await buildTargetTimeline(readers, TARGET);
    expect(t.predictionsLockedBeforeExecution).toBe(false);
  });

  it("notes a replay that did NOT reproduce", async () => {
    const readers = makeReaders({
      dirs: { [locksDir]: ["property-1.lock.json"] },
      files: {
        [join(locksDir, "property-1.lock.json")]: lock(
          "property-1",
          "PASS",
          "2026-01-01T00:00:00.000Z",
        ),
        [join(stageCDir, "exec-all.json")]: JSON.stringify({
          capturedAt: "2026-01-02T00:00:00.000Z",
        }),
        [join(stageCDir, "replay-1.json")]: JSON.stringify({
          capturedAt: "2026-01-02T00:05:00.000Z",
          reproducesSameFail: false,
        }),
        [join(stageDDir, "fix.json")]: JSON.stringify({
          capturedAt: "2026-01-03T00:00:00.000Z",
        }),
        [join(stageDDir, "fix-all.json")]: JSON.stringify({
          capturedAt: "2026-01-03T00:00:00.000Z",
        }),
      },
    });
    const t = await buildTargetTimeline(readers, TARGET);
    const replay = t.steps.find((s) => s.phase === "replay-reproduced")!;
    expect(replay.detail).toMatch(/did not reproduce/);
  });
});

/* -------------------------------------------------------------------------- */
/* Verdict equality between superseded and active locks                       */
/* -------------------------------------------------------------------------- */

describe("buildTargetTimeline — superseded/active verdict check", () => {
  it("reports no verdict mismatch when every superseded verdict matches the active one", async () => {
    const readers = standardReaders({
      supersededNames: ["property-2.lock.json"],
      supersededFiles: {
        // Same property, same verdict (PASS) — only the hash/source changed.
        "property-2.lock.json": lock(
          "property-2",
          "PASS",
          "2026-01-01T03:00:00.000Z",
          "oldhash",
        ),
      },
    });
    const t = await buildTargetTimeline(readers, TARGET);
    expect(t.verdictMismatches).toEqual([]);
    expect(t.harnessRevisions).toBeUndefined(); // no timing declared on TARGET
  });

  it("FLAGS a superseded lock whose verdict differs from the active lock", async () => {
    const readers = standardReaders({
      supersededNames: ["property-2.lock.json"],
      supersededFiles: {
        // A re-lock must NEVER change the verdict; this superseded says FAIL
        // while the active says PASS — a data-integrity flag.
        "property-2.lock.json": lock(
          "property-2",
          "FAIL",
          "2026-01-01T03:00:00.000Z",
          "oldhash",
        ),
      },
    });
    const t = await buildTargetTimeline(readers, TARGET);
    expect(t.verdictMismatches).toEqual([
      {
        propertyId: "property-2",
        activeVerdict: "PASS",
        supersededVerdict: "FAIL",
      },
    ]);
  });

  it("surfaces harnessRevisions (count + timing + README) when timing is declared", async () => {
    const target: TargetSource = {
      ...TARGET,
      harnessRevisionTiming: "after-first-run",
      harnessRevisionTimingNote: "a first run exposed the harness defects",
    };
    const readers = standardReaders({
      supersededNames: ["property-2.lock.json"],
      supersededFiles: {
        "property-2.lock.json": lock(
          "property-2",
          "PASS",
          "2026-01-01T03:00:00.000Z",
          "oldhash",
        ),
      },
    });
    const t = await buildTargetTimeline(readers, target);
    expect(t.harnessRevisions).toEqual({
      count: 1,
      timing: "after-first-run",
      timingNote: "a first run exposed the harness defects",
      readmePath: "rel/demo/locks/superseded/README.md",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Honesty items                                                              */
/* -------------------------------------------------------------------------- */

describe("buildHonestyItems", () => {
  it("resolves the Safety-Gate fix commit from git and links it", async () => {
    const readers = makeReaders({
      dirs: {},
      files: {},
      resolves: {
        [SAFETY_GATE_FIX_COMMITISH]: {
          shortHash: "70d61ad",
          subject: "fix: safety gate whole-token matching",
          date: "2026-11-02T09:42:01+09:00",
        },
      },
    });
    const items = await buildHonestyItems(readers);
    const gate = items[0];
    expect(gate.linkLabel).toBe("70d61ad");
    expect(gate.href).toBe(`${GITHUB_COMMIT_BASE}70d61ad`);
    expect(gate.title).toMatch(/Safety Gate/);
  });

  it("links the writing-tracker and MoodPlays superseded READMEs by repo path", async () => {
    const items = await buildHonestyItems(makeReaders({ dirs: {}, files: {} }));
    const paths = items.slice(1).map((i) => i.href);
    expect(paths).toEqual([
      "packages/mcp-server/skeleton/writing-tracker-full/locks/superseded/README.md",
      "packages/mcp-server/skeleton/moodplays/locks/superseded/README.md",
    ]);
  });

  it("falls back to the commitish when git cannot resolve it", async () => {
    const items = await buildHonestyItems(makeReaders({ dirs: {}, files: {} }));
    // No `resolves` map -> resolveCommit returns null -> fall back to the ish.
    expect(items[0].linkLabel).toBe(SAFETY_GATE_FIX_COMMITISH);
  });
});

/* -------------------------------------------------------------------------- */
/* Full asset assembly                                                        */
/* -------------------------------------------------------------------------- */

describe("buildSectionsAsset", () => {
  it("assembles timelines + isolation + honesty with a fixed generatedAt", async () => {
    const asset = await buildSectionsAsset(
      standardReaders(),
      [TARGET],
      () => new Date("2026-01-04T00:00:00.000Z"),
    );
    expect(asset.generatedAt).toBe("2026-01-04T00:00:00.000Z");
    expect(asset.commitBase).toBe(GITHUB_COMMIT_BASE);
    expect(asset.timelines).toHaveLength(1);
    expect(asset.timelines[0].id).toBe("demo");
    // The isolation model names the two phases and carries source refs.
    expect(asset.isolation.phases.map((p) => p.id)).toEqual(["install", "test"]);
    for (const phase of asset.isolation.phases) {
      for (const g of phase.guarantees) {
        expect(g.source).toMatch(/packages\/mcp-server\/src\/runner\//);
      }
    }
    expect(asset.honesty).toHaveLength(3);
  });
});
