/**
 * Tests for the "Trust or Test?" game-data generator core
 * (../scripts/game-core.ts).
 *
 * The generator joins each target's assembled Lantern_Report with the LOCKED
 * predictions (`locks/*.lock.json`), the EXECUTED verdicts
 * (`results/stage-c/*.json`), and the committed source excerpts, verifying
 * agreement at every join and re-checking the excerpt hash against the sandbox
 * source. These tests drive the PURE core with injected in-memory readers (no
 * filesystem), so the data-fidelity guarantees are asserted deterministically:
 *
 *   - a claim's verdict/prediction come from the stage-c result / lock file;
 *   - a report row whose predicted disagrees with its lock, or whose actual
 *     disagrees with stage-c, THROWS (the asset can never drift);
 *   - an excerpt whose stored hash disagrees with the sandbox source THROWS,
 *     but an ABSENT sandbox source (clean checkout) skips the check;
 *   - `isLie` is the Confirmed_Bug-and-not-symptom rows exactly;
 *   - a symptom FAIL row gets a rootCauseNote and is NOT a lie;
 *   - rows with no excerpt / no VERDICT are omitted;
 *   - assembly requires exactly two lies and at least four PASS claims.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LanternReport, PropertyComparison } from "@spec-lantern/types";
import type { LanternStory } from "./report-asset.js";
import {
  buildGameData,
  buildTargetClaims,
  type GameReaders,
  type GameTargetSource,
} from "../scripts/game-core.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ROOT = "/abs/target";
const SRC = "sandbox/t/file.ts";
const SRC_BYTES = Buffer.from("line1\nline2\nline3\n", "utf8");
const SRC_HASH = createHash("sha256").update(SRC_BYTES).digest("hex");

function comparison(
  partial: Partial<PropertyComparison> & { propertyId: string },
): PropertyComparison {
  return {
    predicted: "PASS",
    actual: { propertyId: partial.propertyId, outcome: "VERDICT", verdict: "PASS" },
    status: "MATCH",
    confirmedBug: false,
    ...partial,
  } as PropertyComparison;
}

const STORY: LanternStory = {
  propertyId: "p1",
  thesis: "t",
  stats: "s",
  comment: { claimText: "c", sourceLocation: "f:1" },
  prediction: { verdict: "PASS", lockedAt: "x", shortHash: "y" },
  execution: { clock: "c", timezone: "UTC", userImpact: "u" },
  revive: {
    diff: "d",
    preFixResult: "FAIL",
    postFixResult: "PASS",
    otherClaimsStatus: "o",
    reproducesSameFail: true,
  },
  credit: "Demo by someone (MIT).",
};

/** Build the on-disk file map for one property's lock + stage-c + excerpt. */
function lockFile(propertyId: string, verdict: string): string {
  return JSON.stringify({ propertyId, verdict, lockedAt: "2026-01-01T00:00:00.000Z" });
}
function stageCFile(propertyId: string, verdict: string): string {
  return JSON.stringify({
    actualResult: { propertyId, outcome: "VERDICT", verdict },
  });
}

/** An excerpt entry with a code slice + the sandbox file hash. */
function excerpt(propertyId: string) {
  return {
    propertyId,
    sourceFile: SRC,
    startLine: 1,
    endLine: 3,
    claimLine: 2,
    claimText: "line2",
    code: "line1\nline2\nline3",
    fileSha256: SRC_HASH,
  };
}

interface FixtureOpts {
  readonly comparisons: readonly PropertyComparison[];
  readonly locks: Record<string, string>;
  readonly stageC: Record<string, string>;
  readonly excerptPropertyIds: readonly string[];
  /** When false, the sandbox source is absent (readSourceBytes -> null). */
  readonly sandboxPresent?: boolean;
  /** Override the stored excerpt hash to force a drift. */
  readonly excerptHashOverride?: string;
}

function makeTarget(opts: FixtureOpts): {
  readers: GameReaders;
  target: GameTargetSource;
} {
  const files: Record<string, string> = {};
  for (const [pid, body] of Object.entries(opts.locks)) {
    files[join(ROOT, "locks", `${pid}.lock.json`)] = body;
  }
  for (const [pid, body] of Object.entries(opts.stageC)) {
    files[join(ROOT, "results", "stage-c", `${pid}.json`)] = body;
  }
  const excerpts = opts.excerptPropertyIds.map((pid) => {
    const e = excerpt(pid);
    return opts.excerptHashOverride
      ? { ...e, fileSha256: opts.excerptHashOverride }
      : e;
  });
  files[join(ROOT, "game", "source-excerpts.json")] = JSON.stringify({ excerpts });

  const readers: GameReaders = {
    async readFile(path) {
      if (path in files) return files[path];
      throw new Error(`no such file: ${path}`);
    },
    async readSourceBytes(repoRel) {
      if (opts.sandboxPresent === false) return null;
      return repoRel === SRC ? SRC_BYTES : null;
    },
  };

  const report: LanternReport = {
    comparisons: opts.comparisons,
    observedDeviations: [],
    noConfirmedBug: false,
    noObservedDeviation: true,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };

  const target: GameTargetSource = {
    id: "demo",
    label: "Demo",
    rootAbs: ROOT,
    repoRootAbs: "/abs",
    report,
    story: STORY,
  };
  return { readers, target };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("buildTargetClaims", () => {
  it("joins report + lock + stage-c + excerpt into a PASS claim", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "p1",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") },
      stageC: { p1: stageCFile("p1", "PASS") },
      excerptPropertyIds: ["p1"],
    });
    const claims = await buildTargetClaims(readers, target);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      propertyId: "p1",
      claimText: "// c",
      sourceLocation: "file.ts:2",
      code: "line1\nline2\nline3",
      verdict: "PASS",
      kiroPrediction: "PASS",
      isLie: false,
    });
    expect(claims[0].counterexamplePlain).toBeUndefined();
  });

  it("marks a Confirmed_Bug (non-symptom) FAIL row as a lie with a counterexample", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "p1",
          predicted: "PASS",
          actual: {
            propertyId: "p1",
            outcome: "VERDICT",
            verdict: "FAIL",
            counterexample: {
              propertyId: "p1",
              input: '[{"x":1}]',
              observedOutput: "expected 'A' to be 'B'",
            },
          },
          status: "PREDICTION_MISMATCH",
          confirmedBug: true,
          display: {
            claimText: "// lie",
            sourceLocation: "file.ts:2",
            evidence: { expected: "A", actual: "B" },
          },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") },
      stageC: { p1: stageCFile("p1", "FAIL") },
      excerptPropertyIds: ["p1"],
    });
    const [claim] = await buildTargetClaims(readers, target);
    expect(claim.isLie).toBe(true);
    expect(claim.verdict).toBe("FAIL");
    expect(claim.counterexamplePlain).toBe(
      "Expected A; execution produced B.",
    );
    expect(claim.rootCauseNote).toBeUndefined();
  });

  it("treats a symptom FAIL row as NOT a lie and attaches a root-cause note", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "p1",
          actual: { propertyId: "p1", outcome: "VERDICT", verdict: "FAIL" },
          status: "PREDICTION_MISMATCH",
          confirmedBug: true,
          display: {
            claimText: "// holds",
            sourceLocation: "file.ts:2",
            symptomOf: "24h-detection bug",
          },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") },
      stageC: { p1: stageCFile("p1", "FAIL") },
      excerptPropertyIds: ["p1"],
    });
    const [claim] = await buildTargetClaims(readers, target);
    expect(claim.isLie).toBe(false);
    expect(claim.rootCauseNote).toContain("24h-detection bug");
  });

  it("omits rows that have no committed excerpt", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "p1",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") },
      stageC: { p1: stageCFile("p1", "PASS") },
      excerptPropertyIds: [], // no excerpt for p1
    });
    expect(await buildTargetClaims(readers, target)).toHaveLength(0);
  });

  it("omits non-VERDICT rows", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "p1",
          actual: { propertyId: "p1", outcome: "NOT_EXECUTED" },
          status: "NOT_EXECUTED",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") },
      stageC: { p1: stageCFile("p1", "PASS") },
      excerptPropertyIds: ["p1"],
    });
    expect(await buildTargetClaims(readers, target)).toHaveLength(0);
  });

  it("throws when the report predicted disagrees with the lock", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "p1",
          predicted: "FAIL", // report says FAIL …
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") }, // … lock says PASS
      stageC: { p1: stageCFile("p1", "PASS") },
      excerptPropertyIds: ["p1"],
    });
    await expect(buildTargetClaims(readers, target)).rejects.toThrow(
      /prediction mismatch/,
    );
  });

  it("throws when the report actual disagrees with stage-c", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "p1",
          actual: { propertyId: "p1", outcome: "VERDICT", verdict: "PASS" },
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") },
      stageC: { p1: stageCFile("p1", "FAIL") }, // stage-c disagrees
      excerptPropertyIds: ["p1"],
    });
    await expect(buildTargetClaims(readers, target)).rejects.toThrow(
      /verdict mismatch/,
    );
  });

  it("throws on a source-hash drift when the sandbox source is present", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "p1",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") },
      stageC: { p1: stageCFile("p1", "PASS") },
      excerptPropertyIds: ["p1"],
      excerptHashOverride: "deadbeef",
      sandboxPresent: true,
    });
    await expect(buildTargetClaims(readers, target)).rejects.toThrow(
      /source hash drift/,
    );
  });

  it("skips the hash check when the sandbox source is absent", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "p1",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") },
      stageC: { p1: stageCFile("p1", "PASS") },
      excerptPropertyIds: ["p1"],
      excerptHashOverride: "deadbeef", // would drift, but sandbox absent
      sandboxPresent: false,
    });
    const claims = await buildTargetClaims(readers, target);
    expect(claims).toHaveLength(1);
  });
});

describe("buildGameData", () => {
  function target(opts: FixtureOpts): GameTargetSource {
    return makeTarget(opts).target;
  }
  function readers(opts: FixtureOpts): GameReaders {
    return makeTarget(opts).readers;
  }

  it("requires exactly two lies across targets", async () => {
    // One target with a single lie -> only 1 lie total -> throw.
    const opts: FixtureOpts = {
      comparisons: [
        comparison({
          propertyId: "p1",
          actual: { propertyId: "p1", outcome: "VERDICT", verdict: "FAIL" },
          confirmedBug: true,
          display: { claimText: "// lie", sourceLocation: "f:2" },
        }),
      ],
      locks: { p1: lockFile("p1", "PASS") },
      stageC: { p1: stageCFile("p1", "FAIL") },
      excerptPropertyIds: ["p1"],
      sandboxPresent: false,
    };
    await expect(
      buildGameData(readers(opts), [target(opts)]),
    ).rejects.toThrow(/exactly 2 lie claims/);
  });

  it("requires at least four held claims", async () => {
    // Two lies, zero PASS in a single target -> not enough held -> throw.
    const lieRow = (pid: string): PropertyComparison =>
      comparison({
        propertyId: pid,
        actual: { propertyId: pid, outcome: "VERDICT", verdict: "FAIL" },
        confirmedBug: true,
        display: { claimText: "// lie", sourceLocation: "f:2" },
      });
    const opts: FixtureOpts = {
      comparisons: [lieRow("p1"), lieRow("p2")],
      locks: { p1: lockFile("p1", "PASS"), p2: lockFile("p2", "PASS") },
      stageC: { p1: stageCFile("p1", "FAIL"), p2: stageCFile("p2", "FAIL") },
      excerptPropertyIds: ["p1", "p2"],
      sandboxPresent: false,
    };
    await expect(
      buildGameData(readers(opts), [target(opts)]),
    ).rejects.toThrow(/at least 4 PASS claims/);
  });

  it("assembles a valid pool (2 lies + >= 4 held) with credits", async () => {
    const passRows = ["p3", "p4", "p5", "p6"].map((pid) =>
      comparison({
        propertyId: pid,
        display: { claimText: `// ${pid}`, sourceLocation: `f:${pid}` },
      }),
    );
    const lieRow = comparison({
      propertyId: "p1",
      actual: { propertyId: "p1", outcome: "VERDICT", verdict: "FAIL" },
      confirmedBug: true,
      display: {
        claimText: "// lie",
        sourceLocation: "f:2",
        evidence: { expected: "A", actual: "B" },
      },
    });
    const lieRow2 = { ...lieRow, propertyId: "p2" } as PropertyComparison;

    const allPids = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const opts: FixtureOpts = {
      comparisons: [lieRow, lieRow2, ...passRows],
      locks: Object.fromEntries(allPids.map((p) => [p, lockFile(p, "PASS")])),
      stageC: Object.fromEntries(
        allPids.map((p) => [
          p,
          stageCFile(p, p === "p1" || p === "p2" ? "FAIL" : "PASS"),
        ]),
      ),
      excerptPropertyIds: allPids,
      sandboxPresent: false,
    };
    const data = await buildGameData(readers(opts), [target(opts)]);
    expect(data.claims.filter((c) => c.isLie)).toHaveLength(2);
    expect(data.claims.filter((c) => c.verdict === "PASS")).toHaveLength(4);
    expect(data.credits).toEqual([
      { targetId: "demo", credit: "Demo by someone (MIT)." },
    ]);
  });
});
