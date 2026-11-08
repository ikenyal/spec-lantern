/**
 * One-off build helper: extract VERBATIM code excerpts from the two pinned
 * Target_Repo sources in `sandbox/` and write a committed `source-excerpts.json`
 * next to each target's spec-lantern artifacts.
 *
 * This is the "extract it once into a committed JSON" step required by the
 * game spec. Each excerpt records its `sourceFile` (sandbox-relative path), one
 * or more `segments` (each a verbatim `code` slice with its line range), the
 * `claimLine` (the comment the round is about, which MUST fall inside a
 * segment), that line's verbatim `claimText`, and the `fileSha256` of the WHOLE
 * source file at the pinned commit. The game GENERATOR (game-core.ts) then
 * re-verifies that SHA-256 whenever the sandbox source is present, so a drift
 * in the target source is caught at build time.
 *
 * Multiple segments (with a visible line gap in the UI) let one claim show BOTH
 * the commented code AND the far-away line where it fails — e.g. the MoodPlays
 * 24-hour claim's comment lives in `parseTimeToMinutes` (L14-23) while the
 * defect is in `extractClosingTime` (L48-54); both belong to the SAME claim
 * (`claim-24h-to-minutes` spans parse + extract), so the round shows both.
 *
 * Run with `vite-node scripts/extract-source-excerpts.ts` from packages/ui.
 * It reads ONLY from sandbox/ (read-only) and writes ONLY the two JSON files.
 * No Target_Repo code is executed.
 *
 * DATA FIDELITY (.kiro/steering/report-data-fidelity.md): every `code` slice is
 * taken straight from the file (never typed by hand), and `fileSha256` is the
 * hash of the exact bytes read, so the committed JSON cannot silently diverge
 * from the real source.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One contiguous line span to slice (1-based, inclusive). */
interface SegmentSpec {
  readonly startLine: number;
  readonly endLine: number;
}

/** One excerpt to extract: which property it illustrates and its segment(s). */
interface ExcerptSpec {
  /** The spec-lantern propertyId the excerpt illustrates. */
  readonly propertyId: string;
  /** Sandbox-relative source path (the pinned Target_Repo file). */
  readonly sourceFile: string;
  /** One or more contiguous segments, in display order. */
  readonly segments: readonly SegmentSpec[];
  /**
   * 1-based absolute source line of the claim comment this round is about. MUST
   * fall inside one of the segments (the extractor asserts this).
   */
  readonly claimLine: number;
}

/** A target's excerpt set keyed by the skeleton directory it is written into. */
interface TargetExcerpts {
  readonly skeletonDir: string;
  readonly excerpts: readonly ExcerptSpec[];
}

const TARGETS: readonly TargetExcerpts[] = [
  {
    skeletonDir: "writing-tracker-full",
    excerpts: [
      {
        propertyId: "property-1.claim-monthly-order",
        sourceFile:
          "sandbox/writing-tracker/src/components/statistics/PeriodProgressSummary.tsx",
        segments: [{ startLine: 40, endLine: 58 }],
        claimLine: 54,
      },
      {
        propertyId: "property-2.claim-active-tasks-recent",
        sourceFile:
          "sandbox/writing-tracker/src/components/statistics/MostActiveItemsList.tsx",
        segments: [{ startLine: 27, endLine: 37 }],
        claimLine: 36,
      },
      {
        propertyId: "property-3.claim-active-stages-top5",
        sourceFile:
          "sandbox/writing-tracker/src/components/statistics/MostActiveItemsList.tsx",
        segments: [{ startLine: 15, endLine: 25 }],
        claimLine: 24,
      },
    ],
  },
  {
    skeletonDir: "moodplays",
    excerpts: [
      {
        // The claim (parse a 24h time -> extract the closing time) spans two
        // functions. Segment 1 is the commented parse branch (the claim's own
        // L17 comment); segment 2 is where it fails: extractClosingTime treats
        // any string containing "24" as open-24h and drops the close time.
        propertyId: "property-1.claim-24h-to-minutes",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        segments: [
          { startLine: 14, endLine: 23 },
          { startLine: 48, endLine: 54 },
        ],
        claimLine: 17,
      },
      {
        propertyId: "property-2.claim-12h-to-minutes",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        segments: [{ startLine: 25, endLine: 37 }],
        claimLine: 25,
      },
      {
        propertyId: "property-3.claim-extract-closing-formats",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        segments: [{ startLine: 55, endLine: 61 }],
        claimLine: 57,
      },
      {
        propertyId: "property-4.claim-24h-never-closing",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        segments: [{ startLine: 48, endLine: 54 }],
        claimLine: 53,
      },
      {
        propertyId: "property-5.claim-after-midnight",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        segments: [{ startLine: 90, endLine: 98 }],
        claimLine: 93,
      },
      {
        propertyId: "property-6.claim-stale-closed",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        segments: [{ startLine: 93, endLine: 103 }],
        claimLine: 100,
      },
      {
        propertyId: "property-7.claim-format-until-close",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        segments: [{ startLine: 112, endLine: 125 }],
        claimLine: 113,
      },
      {
        propertyId: "property-8.claim-haversine-distance",
        sourceFile: "sandbox/moodplays/src/utils/distanceCalculator.ts",
        segments: [{ startLine: 1, endLine: 16 }],
        claimLine: 2,
      },
      {
        propertyId: "property-9.claim-format-distance",
        sourceFile: "sandbox/moodplays/src/utils/distanceCalculator.ts",
        segments: [{ startLine: 34, endLine: 44 }],
        claimLine: 36,
      },
      {
        propertyId: "property-10.claim-mood-categories-lookup",
        sourceFile: "sandbox/moodplays/src/utils/moodMapper.ts",
        segments: [{ startLine: 26, endLine: 31 }],
        claimLine: 29,
      },
    ],
  },
];

async function main(): Promise<void> {
  const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = join(uiRoot, "..", "..");
  const skeletonAbs = join(repoRoot, "packages", "mcp-server", "skeleton");

  // Cache file reads + hashes so a file hit by several excerpts is read once.
  const fileCache = new Map<string, { lines: string[]; sha256: string }>();
  async function loadFile(rel: string) {
    const cached = fileCache.get(rel);
    if (cached) return cached;
    const bytes = await readFile(join(repoRoot, rel));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const lines = bytes.toString("utf8").split("\n");
    const entry = { lines, sha256 };
    fileCache.set(rel, entry);
    return entry;
  }

  for (const { skeletonDir, excerpts } of TARGETS) {
    const out: Record<string, unknown>[] = [];
    for (const spec of excerpts) {
      const { lines, sha256 } = await loadFile(spec.sourceFile);
      const segments = spec.segments.map((seg) => ({
        startLine: seg.startLine,
        endLine: seg.endLine,
        // 1-based inclusive slice.
        code: lines.slice(seg.startLine - 1, seg.endLine).join("\n"),
      }));
      // The claim line must live inside one of the segments.
      const inSegment = spec.segments.some(
        (s) => spec.claimLine >= s.startLine && spec.claimLine <= s.endLine,
      );
      if (!inSegment) {
        throw new Error(
          `claim line ${spec.claimLine} for ${spec.propertyId} is not inside any segment`,
        );
      }
      const claimText = lines[spec.claimLine - 1];
      out.push({
        propertyId: spec.propertyId,
        sourceFile: spec.sourceFile,
        claimLine: spec.claimLine,
        claimText,
        segments,
        fileSha256: sha256,
      });
    }
    const target = { excerpts: out };
    const file = join(skeletonAbs, skeletonDir, "game", "source-excerpts.json");
    await writeFile(file, `${JSON.stringify(target, null, 2)}\n`, "utf8");
    console.log(`wrote ${file} (${out.length} excerpt(s))`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
