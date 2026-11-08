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
 *   - `predictionsLockedBeforeExecution` is COMPUTED from the timestamps
 *     (earliest lockedAt vs execution capturedAt) — true when the lock precedes
 *     execution, false when it does not;
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
  fixResultName: "fix-all.json",
};

const locksDir = join(TARGET.rootAbs, "locks");
const stageCDir = join(TARGET.rootAbs, "results", "stage-c");
const stageDDir = join(TARGET.rootAbs, "results", "stage-d");

/** A reader backed by in-memory file + git maps. */
function makeReaders(opts: {
  files: Record<string, string>;
  dirs: Record<string, readonly string[]>;
  adds?: Record<string, CommitInfo>;
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
    async resolveCommit(commitish) {
      return opts.resolves?.[commitish] ?? null;
    },
  };
}

/** The standard happy-path fixture: lock precedes execution. */
function standardReaders(
  lockedAt = "2026-01-01T00:00:00.000Z",
  executionCapturedAt = "2026-01-02T00:00:00.000Z",
): TimelineReaders {
  return makeReaders({
    dirs: {
      [locksDir]: ["property-1.lock.json", "property-2.lock.json", "notes.txt"],
    },
    files: {
      [join(locksDir, "property-1.lock.json")]: JSON.stringify({
        propertyId: "property-1",
        verdict: "PASS",
        contentHash: "abcdef0123456789aaaa",
        lockedAt,
      }),
      [join(locksDir, "property-2.lock.json")]: JSON.stringify({
        propertyId: "property-2",
        verdict: "PASS",
        contentHash: "ffff",
        // deliberately LATER than property-1 so "earliest" picks property-1.
        lockedAt: "2026-01-01T06:00:00.000Z",
      }),
      [join(stageCDir, "exec-all.json")]: JSON.stringify({
        capturedAt: executionCapturedAt,
      }),
      [join(stageCDir, "replay-1.json")]: JSON.stringify({
        capturedAt: "2026-01-02T00:05:00.000Z",
        reproducesSameFail: true,
      }),
      [join(stageDDir, "fix-all.json")]: JSON.stringify({
        capturedAt: "2026-01-03T00:00:00.000Z",
      }),
    },
    adds: {
      "rel/demo/locks/property-1.lock.json": {
        shortHash: "aaa1111",
        subject: "lock predictions before execution",
        date: "2026-01-01T09:00:00+09:00",
      },
      "rel/demo/results/stage-c/exec-all.json": {
        shortHash: "bbb2222",
        subject: "persist execution results",
        date: "2026-01-02T09:00:00+09:00",
      },
      "rel/demo/results/stage-d/fix-all.json": {
        shortHash: "ccc3333",
        subject: "fix on copy, regression re-run",
        date: "2026-01-03T09:00:00+09:00",
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
      "predictions-locked",
      "lock-commit",
      "execution",
      "replay-reproduced",
      "fix",
      "regression-check",
    ]);
  });

  it("anchors predictions-locked at the EARLIEST lockedAt and shows the lock hash", async () => {
    const t = await buildTargetTimeline(standardReaders(), TARGET);
    const locked = t.steps.find((s) => s.phase === "predictions-locked")!;
    // property-1's lockedAt is earlier than property-2's.
    expect(locked.at).toBe("2026-01-01T00:00:00.000Z");
    // first 12 chars of the anchor lock's contentHash.
    expect(locked.detail).toBe("lock hash abcdef012345");
  });

  it("pulls commit hash + subject from git for lock, execution, and fix", async () => {
    const t = await buildTargetTimeline(standardReaders(), TARGET);
    const byPhase = Object.fromEntries(t.steps.map((s) => [s.phase, s]));
    expect(byPhase["lock-commit"].commit).toBe("aaa1111");
    expect(byPhase["lock-commit"].commitSubject).toMatch(/lock predictions/);
    expect(byPhase["execution"].commit).toBe("bbb2222");
    expect(byPhase["fix"].commit).toBe("ccc3333");
    // regression-check shares the fix commit (same re-execution run).
    expect(byPhase["regression-check"].commit).toBe("ccc3333");
  });

  it("reflects reproducesSameFail on the replay step", async () => {
    const t = await buildTargetTimeline(standardReaders(), TARGET);
    const replay = t.steps.find((s) => s.phase === "replay-reproduced")!;
    expect(replay.at).toBe("2026-01-02T00:05:00.000Z");
    expect(replay.detail).toMatch(/reproduced/);
  });

  it("computes predictionsLockedBeforeExecution = true when the lock precedes execution", async () => {
    const t = await buildTargetTimeline(standardReaders(), TARGET);
    expect(t.predictionsLockedBeforeExecution).toBe(true);
  });

  it("computes predictionsLockedBeforeExecution = false when execution precedes the lock", async () => {
    // Execution captured BEFORE the lock — the flag must be false, not asserted.
    const readers = standardReaders(
      "2026-02-01T00:00:00.000Z", // locked later
      "2026-01-01T00:00:00.000Z", // executed earlier
    );
    const t = await buildTargetTimeline(readers, TARGET);
    expect(t.predictionsLockedBeforeExecution).toBe(false);
  });

  it("notes a replay that did NOT reproduce", async () => {
    const readers = makeReaders({
      dirs: { [locksDir]: ["property-1.lock.json"] },
      files: {
        [join(locksDir, "property-1.lock.json")]: JSON.stringify({
          contentHash: "abcdef0123456789",
          lockedAt: "2026-01-01T00:00:00.000Z",
        }),
        [join(stageCDir, "exec-all.json")]: JSON.stringify({
          capturedAt: "2026-01-02T00:00:00.000Z",
        }),
        [join(stageCDir, "replay-1.json")]: JSON.stringify({
          capturedAt: "2026-01-02T00:05:00.000Z",
          reproducesSameFail: false,
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
