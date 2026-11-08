/**
 * Build-time CLI that writes the "Trust or Test?" game-data asset
 * (public/reports/game.json).
 *
 * Run with `npm run generate:game -w @spec-lantern/ui` (invoked by `build:demo`
 * before the Vite build).
 *
 * THIN wrapper: all logic lives in the pure, testable core
 * ({@link ./game-core.ts}). Here we only wire in the real `fs` readers + the
 * on-disk assembled reports (src/real-report.ts, src/moodplays-report.ts) and
 * write the result to disk.
 *
 * DATA FIDELITY: the core cross-checks the report rows against `locks/` and
 * `results/stage-c/` and re-verifies the committed excerpt hashes against the
 * sandbox source (when present). Nothing is hand-typed.
 */
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WRITING_TRACKER_REPORT,
  WRITING_TRACKER_STORY,
} from "../src/real-report.js";
import {
  MOODPLAYS_REPORT,
  MOODPLAYS_STORY,
} from "../src/moodplays-report.js";
import { buildGameData, type GameReaders, type GameTargetSource } from "./game-core.js";

async function main(): Promise<void> {
  const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = join(uiRoot, "..", "..");
  const skeletonAbs = join(repoRoot, "packages", "mcp-server", "skeleton");

  const readers: GameReaders = {
    readFile: (path) => readFile(path, "utf8"),
    async readSourceBytes(repoRelPath) {
      try {
        return await readFile(join(repoRoot, repoRelPath));
      } catch {
        // sandbox/ is gitignored; absent on a clean checkout -> skip hash check.
        return null;
      }
    },
  };

  const targets: GameTargetSource[] = [
    {
      id: "writing-tracker",
      label: "writing-tracker",
      rootAbs: join(skeletonAbs, "writing-tracker-full"),
      repoRootAbs: repoRoot,
      report: WRITING_TRACKER_REPORT,
      story: WRITING_TRACKER_STORY,
    },
    {
      id: "moodplays",
      label: "MoodPlays",
      rootAbs: join(skeletonAbs, "moodplays"),
      repoRootAbs: repoRoot,
      report: MOODPLAYS_REPORT,
      story: MOODPLAYS_STORY,
    },
  ];

  const data = await buildGameData(readers, targets);

  const outDir = join(uiRoot, "public", "reports");
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, "game.json");
  await writeFile(outFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(
    `generated /reports/game.json (${data.claims.length} claim(s), ` +
      `${data.claims.filter((c) => c.isLie).length} lie(s), ` +
      `${data.credits.length} credit(s))`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
