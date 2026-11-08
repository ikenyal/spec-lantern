/**
 * One-off build helper: extract VERBATIM code excerpts from the two pinned
 * Target_Repo sources in `sandbox/` and write a committed `source-excerpts.json`
 * next to each target's spec-lantern artifacts.
 *
 * This is the "extract it once into a committed JSON" step required by the
 * game spec: each excerpt records its `sourceFile` (sandbox-relative path),
 * `startLine`/`endLine`, the verbatim `code`, and the `fileSha256` of the WHOLE
 * source file at the pinned commit. The game GENERATOR (game-core.ts) then
 * re-verifies that SHA-256 whenever the sandbox source is present, so a drift
 * in the target source is caught at build time.
 *
 * Run with `vite-node scripts/extract-source-excerpts.ts` from packages/ui.
 * It reads ONLY from sandbox/ (read-only) and writes ONLY the two JSON files.
 * No Target_Repo code is executed.
 *
 * DATA FIDELITY (.kiro/steering/report-data-fidelity.md): the `code` field is
 * sliced straight from the file (never typed by hand), and `fileSha256` is the
 * hash of the exact bytes read, so the committed JSON cannot silently diverge
 * from the real source.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One excerpt to extract: which property it illustrates and the line span. */
interface ExcerptSpec {
  /** The spec-lantern propertyId the excerpt illustrates. */
  readonly propertyId: string;
  /** Sandbox-relative source path (the pinned Target_Repo file). */
  readonly sourceFile: string;
  /** 1-based inclusive first line of the excerpt. */
  readonly startLine: number;
  /** 1-based inclusive last line of the excerpt. */
  readonly endLine: number;
  /**
   * The exact one-line claim comment (verbatim) this round is about, as it
   * appears in the report's `display.claimText`. Used by the game as the
   * highlighted "comment under test".
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
        startLine: 40,
        endLine: 58,
        claimLine: 54,
      },
      {
        propertyId: "property-2.claim-active-tasks-recent",
        sourceFile:
          "sandbox/writing-tracker/src/components/statistics/MostActiveItemsList.tsx",
        startLine: 27,
        endLine: 37,
        claimLine: 36,
      },
      {
        propertyId: "property-3.claim-active-stages-top5",
        sourceFile:
          "sandbox/writing-tracker/src/components/statistics/MostActiveItemsList.tsx",
        startLine: 15,
        endLine: 25,
        claimLine: 24,
      },
    ],
  },
  {
    skeletonDir: "moodplays",
    excerpts: [
      {
        propertyId: "property-1.claim-24h-to-minutes",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        startLine: 48,
        endLine: 61,
        claimLine: 51,
      },
      {
        propertyId: "property-2.claim-12h-to-minutes",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        startLine: 25,
        endLine: 37,
        claimLine: 25,
      },
      {
        propertyId: "property-3.claim-extract-closing-formats",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        startLine: 55,
        endLine: 61,
        claimLine: 57,
      },
      {
        propertyId: "property-4.claim-24h-never-closing",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        startLine: 48,
        endLine: 54,
        claimLine: 53,
      },
      {
        propertyId: "property-5.claim-after-midnight",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        startLine: 90,
        endLine: 98,
        claimLine: 93,
      },
      {
        propertyId: "property-6.claim-stale-closed",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        startLine: 93,
        endLine: 103,
        claimLine: 100,
      },
      {
        propertyId: "property-7.claim-format-until-close",
        sourceFile: "sandbox/moodplays/src/utils/openingHoursParser.ts",
        startLine: 112,
        endLine: 125,
        claimLine: 113,
      },
      {
        propertyId: "property-8.claim-haversine-distance",
        sourceFile: "sandbox/moodplays/src/utils/distanceCalculator.ts",
        startLine: 1,
        endLine: 16,
        claimLine: 2,
      },
      {
        propertyId: "property-9.claim-format-distance",
        sourceFile: "sandbox/moodplays/src/utils/distanceCalculator.ts",
        startLine: 34,
        endLine: 44,
        claimLine: 36,
      },
      {
        propertyId: "property-10.claim-mood-categories-lookup",
        sourceFile: "sandbox/moodplays/src/utils/moodMapper.ts",
        startLine: 26,
        endLine: 31,
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
    // Split on \n, preserving the file's own line boundaries (no trailing
    // normalization — a trailing newline just yields a final empty element we
    // never index into).
    const lines = bytes.toString("utf8").split("\n");
    const entry = { lines, sha256 };
    fileCache.set(rel, entry);
    return entry;
  }

  for (const { skeletonDir, excerpts } of TARGETS) {
    const out: Record<string, unknown>[] = [];
    for (const spec of excerpts) {
      const { lines, sha256 } = await loadFile(spec.sourceFile);
      // 1-based inclusive slice.
      const code = lines.slice(spec.startLine - 1, spec.endLine).join("\n");
      const claimText = lines[spec.claimLine - 1];
      out.push({
        propertyId: spec.propertyId,
        sourceFile: spec.sourceFile,
        startLine: spec.startLine,
        endLine: spec.endLine,
        claimLine: spec.claimLine,
        claimText,
        code,
        fileSha256: sha256,
      });
    }
    const target = { excerpts: out };
    const file = join(skeletonAbs, skeletonDir, "game", "source-excerpts.json");
    await writeFile(
      file,
      `${JSON.stringify(target, null, 2)}\n`,
      "utf8",
    );
    console.log(`wrote ${file} (${out.length} excerpt(s))`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
