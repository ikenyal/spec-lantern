/**
 * Tests for the "Trust or Test?" game-data generator core
 * (../scripts/game-core.ts).
 *
 * The generator joins each target's assembled Lantern_Report with the LOCKED
 * predictions (`locks/*.lock.json`), the EXECUTED verdicts
 * (`results/stage-c/*.json`), the claim descriptions (`claims.json`), and the
 * committed source excerpts (now MULTI-SEGMENT), verifying agreement at every
 * join and re-checking the excerpt hash against the sandbox source. These tests
 * drive the PURE core with injected in-memory readers (no filesystem), so the
 * data-fidelity guarantees are asserted deterministically:
 *
 *   - a claim's verdict/prediction come from the stage-c result / lock file;
 *   - a report row whose predicted disagrees with its lock, or whose actual
 *     disagrees with stage-c, THROWS;
 *   - an excerpt whose stored hash disagrees with the sandbox source THROWS,
 *     but an ABSENT sandbox source (clean checkout) skips the check;
 *   - the claim description comes VERBATIM from claims.json;
 *   - the SAME-CLAIM check fails the build when the claim line is not inside a
 *     segment or not referenced by the claim's commentRef;
 *   - "How to spot it" is the report story wording (lie) / a factual run line
 *     (held), omitted when unavailable; held omits the count when unrecorded;
 *   - `isLie` is the Confirmed_Bug-and-not-symptom rows exactly;
 *   - assembly requires exactly two lies and >= four non-overlapping PASS
 *     claims, excluding held claims that overlap a lie's excerpt.
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
// A 120-line source stand-in so any excerpt range resolves; the exact bytes
// matter only for the SHA-256 the generator re-verifies.
const SRC_BYTES = Buffer.from(
  Array.from({ length: 120 }, (_, i) => `line${i + 1}`).join("\n") + "\n",
  "utf8",
);
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
  propertyId: "property-1.claim-lie",
  thesis: "t",
  stats: "s",
  comment: { claimText: "c", sourceLocation: "f:2" },
  prediction: { verdict: "PASS", lockedAt: "x", shortHash: "y" },
  execution: {
    clock: "c",
    timezone: "UTC",
    userImpact: "Users see the wrong thing at the top.",
  },
  revive: {
    diff: "d",
    preFixResult: "FAIL",
    postFixResult: "PASS",
    otherClaimsStatus: "o",
    reproducesSameFail: true,
  },
  credit: "Demo by someone (MIT).",
};

function lockFile(propertyId: string, verdict: string): string {
  return JSON.stringify({ propertyId, verdict, lockedAt: "2026-01-01T00:00:00.000Z" });
}
function stageCFile(
  propertyId: string,
  verdict: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    actualResult: { propertyId, outcome: "VERDICT", verdict, ...extra },
  });
}

/** The claim id is the propertyId suffix after the first dot. */
function claimIdOf(propertyId: string): string {
  const dot = propertyId.indexOf(".");
  return dot === -1 ? propertyId : propertyId.slice(dot + 1);
}

/** Per-property excerpt overrides. */
interface ExcerptSpec {
  readonly sourceFile?: string;
  readonly claimLine?: number;
  readonly claimText?: string;
  readonly segments?: readonly { startLine: number; endLine: number }[];
}

/** Build an excerpt entry (segments with synthetic code) + the file hash. */
function excerpt(propertyId: string, spec: ExcerptSpec = {}) {
  const segments = (spec.segments ?? [{ startLine: 1, endLine: 3 }]).map(
    (s) => ({
      startLine: s.startLine,
      endLine: s.endLine,
      code: Array.from(
        { length: s.endLine - s.startLine + 1 },
        (_, i) => `line${s.startLine + i}`,
      ).join("\n"),
    }),
  );
  const claimLine = spec.claimLine ?? 2;
  return {
    propertyId,
    sourceFile: spec.sourceFile ?? SRC,
    claimLine,
    claimText: spec.claimText ?? `line${claimLine}`,
    segments,
    fileSha256: SRC_HASH,
  };
}

interface FixtureOpts {
  readonly comparisons: readonly PropertyComparison[];
  readonly locks: Record<string, string>;
  readonly stageC: Record<string, string>;
  readonly excerptPropertyIds: readonly string[];
  readonly excerptSpecs?: Record<string, ExcerptSpec>;
  /**
   * Per-claim-id commentRef (defaults to a ref that includes the excerpt's
   * claim line so the same-claim check passes). Set to override/omit.
   */
  readonly commentRefs?: Record<string, string>;
  /** Per-claim-id description (defaults to "desc for <id>"). */
  readonly descriptions?: Record<string, string>;
  readonly story?: LanternStory;
  readonly sandboxPresent?: boolean;
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
    const e = excerpt(pid, opts.excerptSpecs?.[pid]);
    return opts.excerptHashOverride
      ? { ...e, fileSha256: opts.excerptHashOverride }
      : e;
  });
  files[join(ROOT, "game", "source-excerpts.json")] = JSON.stringify({ excerpts });

  // claims.json: one entry per excerpted property, keyed by claim id. The
  // commentRef defaults to referencing the excerpt's claim line (so the
  // same-claim check passes) unless overridden.
  const claims = opts.excerptPropertyIds.map((pid) => {
    const id = claimIdOf(pid);
    const line = opts.excerptSpecs?.[pid]?.claimLine ?? 2;
    return {
      id,
      description: opts.descriptions?.[id] ?? `desc for ${id}`,
      commentRef: opts.commentRefs?.[id] ?? `L${line} // ${id}`,
    };
  });
  files[join(ROOT, "claims.json")] = JSON.stringify({ claims });

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
    story: opts.story ?? STORY,
  };
  return { readers, target };
}

/* -------------------------------------------------------------------------- */
/* buildTargetClaims                                                          */
/* -------------------------------------------------------------------------- */

describe("buildTargetClaims", () => {
  it("joins report + lock + stage-c + claims.json + excerpt into a PASS claim", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-7.claim-held",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { "property-7.claim-held": lockFile("property-7.claim-held", "PASS") },
      stageC: { "property-7.claim-held": stageCFile("property-7.claim-held", "PASS") },
      excerptPropertyIds: ["property-7.claim-held"],
      descriptions: { "claim-held": "A held claim's one-sentence description." },
    });
    const claims = await buildTargetClaims(readers, target);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      propertyId: "property-7.claim-held",
      claimId: "claim-held",
      claimText: "// c",
      sourceLocation: "file.ts:2",
      description: "A held claim's one-sentence description.",
      verdict: "PASS",
      kiroPrediction: "PASS",
      isLie: false,
    });
    expect(claims[0].segments).toHaveLength(1);
    expect(claims[0].counterexamplePlain).toBeUndefined();
  });

  it("carries the claims.json description verbatim", async () => {
    const desc = "A 24-hour time parses to minutes since midnight.";
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-2.claim-x",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { "property-2.claim-x": lockFile("property-2.claim-x", "PASS") },
      stageC: { "property-2.claim-x": stageCFile("property-2.claim-x", "PASS") },
      excerptPropertyIds: ["property-2.claim-x"],
      descriptions: { "claim-x": desc },
    });
    const [claim] = await buildTargetClaims(readers, target);
    expect(claim.description).toBe(desc);
  });

  it("marks a Confirmed_Bug (non-symptom) FAIL row as a lie, with story 'how to spot' + counterexample", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-1.claim-lie",
          predicted: "PASS",
          actual: {
            propertyId: "property-1.claim-lie",
            outcome: "VERDICT",
            verdict: "FAIL",
            counterexample: {
              propertyId: "property-1.claim-lie",
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
      locks: { "property-1.claim-lie": lockFile("property-1.claim-lie", "PASS") },
      stageC: { "property-1.claim-lie": stageCFile("property-1.claim-lie", "FAIL") },
      excerptPropertyIds: ["property-1.claim-lie"],
      story: STORY, // story.propertyId === "property-1.claim-lie"
    });
    const [claim] = await buildTargetClaims(readers, target);
    expect(claim.isLie).toBe(true);
    expect(claim.verdict).toBe("FAIL");
    // "How to spot it" for a lie is the report story's user-impact wording.
    expect(claim.howToSpot).toBe("Users see the wrong thing at the top.");
    expect(claim.counterexamplePlain).toBe("Expected A; execution produced B.");
    expect(claim.rootCauseNote).toBeUndefined();
  });

  it("gives a held claim a factual 'how to spot' line, with the run count when recorded", async () => {
    // Without a recorded count -> no number.
    const noCount = makeTarget({
      comparisons: [comparison({ propertyId: "property-3.claim-a", display: { claimText: "// a", sourceLocation: "file.ts:2" } })],
      locks: { "property-3.claim-a": lockFile("property-3.claim-a", "PASS") },
      stageC: { "property-3.claim-a": stageCFile("property-3.claim-a", "PASS") },
      excerptPropertyIds: ["property-3.claim-a"],
    });
    const [a] = await buildTargetClaims(noCount.readers, noCount.target);
    expect(a.howToSpot).toBe(
      "Execution ran generated inputs and every one matched the comment, so the claim held.",
    );

    // With a recorded numRuns -> includes the number.
    const withCount = makeTarget({
      comparisons: [comparison({ propertyId: "property-3.claim-a", display: { claimText: "// a", sourceLocation: "file.ts:2" } })],
      locks: { "property-3.claim-a": lockFile("property-3.claim-a", "PASS") },
      stageC: {
        "property-3.claim-a": stageCFile("property-3.claim-a", "PASS", { numRuns: 100 }),
      },
      excerptPropertyIds: ["property-3.claim-a"],
    });
    const [b] = await buildTargetClaims(withCount.readers, withCount.target);
    expect(b.howToSpot).toBe(
      "Execution ran 100 generated inputs and every one matched the comment, so the claim held.",
    );
  });

  it("treats a symptom FAIL row as NOT a lie and attaches a root-cause note", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-6.claim-symptom",
          actual: { propertyId: "property-6.claim-symptom", outcome: "VERDICT", verdict: "FAIL" },
          status: "PREDICTION_MISMATCH",
          confirmedBug: true,
          display: {
            claimText: "// holds",
            sourceLocation: "file.ts:2",
            symptomOf: "24h-detection bug",
          },
        }),
      ],
      locks: { "property-6.claim-symptom": lockFile("property-6.claim-symptom", "PASS") },
      stageC: { "property-6.claim-symptom": stageCFile("property-6.claim-symptom", "FAIL") },
      excerptPropertyIds: ["property-6.claim-symptom"],
    });
    const [claim] = await buildTargetClaims(readers, target);
    expect(claim.isLie).toBe(false);
    expect(claim.rootCauseNote).toContain("24h-detection bug");
  });

  it("supports a multi-segment excerpt and highlights the claim line inside its segment", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-1.claim-multi",
          display: { claimText: "// at line 17", sourceLocation: "file.ts:17" },
        }),
      ],
      locks: { "property-1.claim-multi": lockFile("property-1.claim-multi", "PASS") },
      stageC: { "property-1.claim-multi": stageCFile("property-1.claim-multi", "PASS") },
      excerptPropertyIds: ["property-1.claim-multi"],
      excerptSpecs: {
        "property-1.claim-multi": {
          claimLine: 17,
          segments: [
            { startLine: 14, endLine: 23 },
            { startLine: 48, endLine: 54 },
          ],
        },
      },
      commentRefs: { "claim-multi": "L12 foo ; L17 // at line 17" },
    });
    const [claim] = await buildTargetClaims(readers, target);
    expect(claim.segments.map((s) => [s.startLine, s.endLine])).toEqual([
      [14, 23],
      [48, 54],
    ]);
    expect(claim.claimLine).toBe(17);
    expect(claim.sourceLocation).toBe("file.ts:17");
  });

  it("throws when the claim line is not inside any excerpt segment (Fix 3 same-claim check)", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-1.claim-x",
          display: { claimText: "// c", sourceLocation: "file.ts:99" },
        }),
      ],
      locks: { "property-1.claim-x": lockFile("property-1.claim-x", "PASS") },
      stageC: { "property-1.claim-x": stageCFile("property-1.claim-x", "PASS") },
      excerptPropertyIds: ["property-1.claim-x"],
      excerptSpecs: {
        "property-1.claim-x": { claimLine: 99, segments: [{ startLine: 14, endLine: 23 }] },
      },
      commentRefs: { "claim-x": "L99 // c" },
    });
    await expect(buildTargetClaims(readers, target)).rejects.toThrow(
      /claim line 99 .* not inside any excerpt segment/,
    );
  });

  it("throws when the claim line is not referenced by the claim's commentRef (Fix 3 same-claim check)", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-1.claim-x",
          display: { claimText: "// c", sourceLocation: "file.ts:20" },
        }),
      ],
      locks: { "property-1.claim-x": lockFile("property-1.claim-x", "PASS") },
      stageC: { "property-1.claim-x": stageCFile("property-1.claim-x", "PASS") },
      excerptPropertyIds: ["property-1.claim-x"],
      excerptSpecs: {
        "property-1.claim-x": { claimLine: 20, segments: [{ startLine: 14, endLine: 23 }] },
      },
      // commentRef points at L14/L17, NOT the claim line 20 -> mismatch.
      commentRefs: { "claim-x": "L14 foo ; L17 bar" },
    });
    await expect(buildTargetClaims(readers, target)).rejects.toThrow(
      /not referenced by claim claim-x's commentRef/,
    );
  });

  it("throws when there is no claims.json entry for the claim id", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-1.claim-x",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { "property-1.claim-x": lockFile("property-1.claim-x", "PASS") },
      stageC: { "property-1.claim-x": stageCFile("property-1.claim-x", "PASS") },
      excerptPropertyIds: ["property-1.claim-x"],
    });
    // Remove the claims.json entry by swapping in an empty claims file.
    const brokenReaders: GameReaders = {
      ...readers,
      async readFile(path) {
        if (path.endsWith("claims.json")) return JSON.stringify({ claims: [] });
        return readers.readFile(path);
      },
    };
    await expect(buildTargetClaims(brokenReaders, target)).rejects.toThrow(
      /no claims.json entry for claim-x/,
    );
  });

  it("throws when the report predicted disagrees with the lock", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-1.claim-x",
          predicted: "FAIL",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { "property-1.claim-x": lockFile("property-1.claim-x", "PASS") },
      stageC: { "property-1.claim-x": stageCFile("property-1.claim-x", "PASS") },
      excerptPropertyIds: ["property-1.claim-x"],
    });
    await expect(buildTargetClaims(readers, target)).rejects.toThrow(
      /prediction mismatch/,
    );
  });

  it("throws when the report actual disagrees with stage-c", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-1.claim-x",
          actual: { propertyId: "property-1.claim-x", outcome: "VERDICT", verdict: "PASS" },
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { "property-1.claim-x": lockFile("property-1.claim-x", "PASS") },
      stageC: { "property-1.claim-x": stageCFile("property-1.claim-x", "FAIL") },
      excerptPropertyIds: ["property-1.claim-x"],
    });
    await expect(buildTargetClaims(readers, target)).rejects.toThrow(
      /verdict mismatch/,
    );
  });

  it("throws on a source-hash drift when the sandbox source is present", async () => {
    const { readers, target } = makeTarget({
      comparisons: [
        comparison({
          propertyId: "property-1.claim-x",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { "property-1.claim-x": lockFile("property-1.claim-x", "PASS") },
      stageC: { "property-1.claim-x": stageCFile("property-1.claim-x", "PASS") },
      excerptPropertyIds: ["property-1.claim-x"],
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
          propertyId: "property-1.claim-x",
          display: { claimText: "// c", sourceLocation: "file.ts:2" },
        }),
      ],
      locks: { "property-1.claim-x": lockFile("property-1.claim-x", "PASS") },
      stageC: { "property-1.claim-x": stageCFile("property-1.claim-x", "PASS") },
      excerptPropertyIds: ["property-1.claim-x"],
      excerptHashOverride: "deadbeef",
      sandboxPresent: false,
    });
    const claims = await buildTargetClaims(readers, target);
    expect(claims).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* buildGameData                                                              */
/* -------------------------------------------------------------------------- */

describe("buildGameData", () => {
  function target(opts: FixtureOpts): GameTargetSource {
    return makeTarget(opts).target;
  }
  function readers(opts: FixtureOpts): GameReaders {
    return makeTarget(opts).readers;
  }

  /** A held PASS row + its excerpt spec (disjoint range) in one file. */
  function heldRow(pid: string, line: number): PropertyComparison {
    return comparison({
      propertyId: pid,
      display: { claimText: `// ${pid}`, sourceLocation: `x:${line}` },
    });
  }

  it("requires exactly two lies across targets", async () => {
    const opts: FixtureOpts = {
      comparisons: [
        comparison({
          propertyId: "property-1.claim-lie",
          actual: { propertyId: "property-1.claim-lie", outcome: "VERDICT", verdict: "FAIL" },
          confirmedBug: true,
          display: { claimText: "// lie", sourceLocation: "f:2" },
        }),
      ],
      locks: { "property-1.claim-lie": lockFile("property-1.claim-lie", "PASS") },
      stageC: { "property-1.claim-lie": stageCFile("property-1.claim-lie", "FAIL") },
      excerptPropertyIds: ["property-1.claim-lie"],
      sandboxPresent: false,
    };
    await expect(
      buildGameData(readers(opts), [target(opts)]),
    ).rejects.toThrow(/exactly 2 lie claims/);
  });

  it("requires at least four non-overlapping held claims", async () => {
    const lie = (pid: string): PropertyComparison =>
      comparison({
        propertyId: pid,
        actual: { propertyId: pid, outcome: "VERDICT", verdict: "FAIL" },
        confirmedBug: true,
        display: { claimText: "// lie", sourceLocation: "f:2" },
      });
    const opts: FixtureOpts = {
      comparisons: [lie("property-1.claim-lie"), lie("property-2.claim-lie2")],
      locks: {
        "property-1.claim-lie": lockFile("property-1.claim-lie", "PASS"),
        "property-2.claim-lie2": lockFile("property-2.claim-lie2", "PASS"),
      },
      stageC: {
        "property-1.claim-lie": stageCFile("property-1.claim-lie", "FAIL"),
        "property-2.claim-lie2": stageCFile("property-2.claim-lie2", "FAIL"),
      },
      excerptPropertyIds: ["property-1.claim-lie", "property-2.claim-lie2"],
      sandboxPresent: false,
    };
    await expect(
      buildGameData(readers(opts), [target(opts)]),
    ).rejects.toThrow(/at least 4 non-overlapping PASS claims/);
  });

  it("assembles a valid pool (2 lies + >= 4 held) with credits", async () => {
    const lie = comparison({
      propertyId: "property-1.claim-lie",
      actual: {
        propertyId: "property-1.claim-lie",
        outcome: "VERDICT",
        verdict: "FAIL",
        counterexample: { propertyId: "property-1.claim-lie", input: "[]", observedOutput: "expected 'A' to be 'B'" },
      },
      confirmedBug: true,
      display: { claimText: "// lie", sourceLocation: "f:2", evidence: { expected: "A", actual: "B" } },
    });
    const lie2 = comparison({
      propertyId: "property-2.claim-lie2",
      actual: { propertyId: "property-2.claim-lie2", outcome: "VERDICT", verdict: "FAIL" },
      confirmedBug: true,
      display: { claimText: "// lie2", sourceLocation: "f:2" },
    });
    const held = ["property-3.claim-h1", "property-4.claim-h2", "property-5.claim-h3", "property-6.claim-h4"].map(
      (pid, i) => heldRow(pid, i * 10 + 2),
    );
    const comparisons = [lie, lie2, ...held];
    const allPids = comparisons.map((c) => c.propertyId);
    const excerptSpecs: Record<string, ExcerptSpec> = Object.fromEntries(
      allPids.map((p, i) => [
        p,
        { startLine: i * 10 + 1, endLine: i * 10 + 3, claimLine: i * 10 + 2, segments: [{ startLine: i * 10 + 1, endLine: i * 10 + 3 }] },
      ]),
    );
    const opts: FixtureOpts = {
      comparisons,
      locks: Object.fromEntries(allPids.map((p) => [p, lockFile(p, "PASS")])),
      stageC: Object.fromEntries(
        allPids.map((p) => [
          p,
          stageCFile(p, p.startsWith("property-1.") || p.startsWith("property-2.") ? "FAIL" : "PASS"),
        ]),
      ),
      excerptPropertyIds: allPids,
      excerptSpecs,
      sandboxPresent: false,
    };
    const data = await buildGameData(readers(opts), [target(opts)]);
    expect(data.claims.filter((c) => c.isLie)).toHaveLength(2);
    expect(data.claims.filter((c) => c.verdict === "PASS")).toHaveLength(4);
    expect(data.credits).toEqual([
      { targetId: "demo", credit: "Demo by someone (MIT)." },
    ]);
  });

  it("excludes a held claim whose excerpt overlaps a lie's excerpt in the same file (Fix 3 fairness)", async () => {
    const SAME = "sandbox/t/opening.ts";
    const lie = comparison({
      propertyId: "property-1.claim-lie",
      actual: { propertyId: "property-1.claim-lie", outcome: "VERDICT", verdict: "FAIL" },
      confirmedBug: true,
      display: { claimText: "// lie", sourceLocation: `${SAME}:51` },
    });
    const lie2 = comparison({
      propertyId: "property-2.claim-lie2",
      actual: { propertyId: "property-2.claim-lie2", outcome: "VERDICT", verdict: "FAIL" },
      confirmedBug: true,
      display: { claimText: "// lie2", sourceLocation: "sandbox/t/other.ts:5" },
    });
    const comparisons = [
      lie,
      lie2,
      heldRow("property-3.claim-overlap", 53),
      heldRow("property-4.claim-h1", 70),
      heldRow("property-5.claim-h2", 80),
      heldRow("property-6.claim-h3", 90),
      heldRow("property-7.claim-h4", 100),
    ];
    const allPids = comparisons.map((c) => c.propertyId);
    const excerptSpecs: Record<string, ExcerptSpec> = {
      "property-1.claim-lie": { sourceFile: SAME, claimLine: 51, segments: [{ startLine: 48, endLine: 54 }] },
      "property-2.claim-lie2": { sourceFile: "sandbox/t/other.ts", claimLine: 5, segments: [{ startLine: 1, endLine: 8 }] },
      "property-3.claim-overlap": { sourceFile: SAME, claimLine: 53, segments: [{ startLine: 53, endLine: 54 }] },
      "property-4.claim-h1": { sourceFile: SAME, claimLine: 70, segments: [{ startLine: 70, endLine: 72 }] },
      "property-5.claim-h2": { sourceFile: SAME, claimLine: 80, segments: [{ startLine: 80, endLine: 82 }] },
      "property-6.claim-h3": { sourceFile: SAME, claimLine: 90, segments: [{ startLine: 90, endLine: 92 }] },
      "property-7.claim-h4": { sourceFile: SAME, claimLine: 100, segments: [{ startLine: 100, endLine: 102 }] },
    };
    const opts: FixtureOpts = {
      comparisons,
      locks: Object.fromEntries(allPids.map((p) => [p, lockFile(p, "PASS")])),
      stageC: Object.fromEntries(
        allPids.map((p) => [
          p,
          stageCFile(p, p.startsWith("property-1.") || p.startsWith("property-2.") ? "FAIL" : "PASS"),
        ]),
      ),
      excerptPropertyIds: allPids,
      excerptSpecs,
      sandboxPresent: false,
    };
    const data = await buildGameData(readers(opts), [target(opts)]);
    const ids = data.claims.map((c) => c.claimId);
    expect(ids).not.toContain("claim-overlap");
    expect(ids).toContain("claim-lie");
    expect(data.claims.filter((c) => c.verdict === "PASS" && !c.isLie)).toHaveLength(4);
  });
});
