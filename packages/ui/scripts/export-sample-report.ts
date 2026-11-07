/**
 * Export step (task 19.1): serialize the pre-generated sample Lantern_Report(s)
 * to static JSON assets the Hosted_Demo UI loads client-side.
 *
 * Run with `npm run export:sample -w @spec-lantern/ui`. It writes:
 *   - public/reports/<id>.json  — one {@link ReportAsset} per report
 *   - public/reports/index.json — the {@link ReportManifest} listing them
 *
 * These files land under `public/`, which Vite copies verbatim into the built
 * static site, so the demo (task 19.2) serves them with no runner and no
 * Target_Repo execution — it only fetches static JSON.
 *
 * Data fidelity: this script re-serializes EXISTING, verified report data —
 * now the REAL pipeline output in {@link WRITING_TRACKER_REPORT}
 * (src/real-report.ts), assembled from the writing-tracker-full execution
 * artifacts. It invents nothing: the `sampleData` flag comes straight from
 * `IS_SAMPLE_DATA` (now false, so the UI badge is gone), and the row content
 * is the report object unchanged.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ReportAsset,
  ReportManifest,
  ReportManifestEntry,
} from "../src/report-asset.js";
import { reportAssetPath } from "../src/report-asset.js";
import {
  WRITING_TRACKER_REPORT,
  WRITING_TRACKER_STORY,
  IS_SAMPLE_DATA,
} from "../src/real-report.js";
import {
  MOODPLAYS_REPORT,
  MOODPLAYS_STORY,
  MOODPLAYS_IS_SAMPLE_DATA,
} from "../src/moodplays-report.js";

/** A report to export: its slug id, labels, and the data + sample flag. */
interface ExportableReport {
  readonly id: string;
  readonly title: string;
  /** Short label for the target-switcher tab. */
  readonly switchLabel: string;
  /** Human label for the report header ("Target: <targetLabel>"). */
  readonly targetLabel: string;
  readonly asset: ReportAsset;
}

/**
 * The reports to export. Two real pipeline reports (Stage B–D each):
 * writing-tracker and MoodPlays. The manifest shape supports "one or more"; the
 * demo's target switcher lists them all.
 */
const REPORTS: readonly ExportableReport[] = [
  {
    id: "writing-tracker",
    title: "writing-tracker (revived Lovable app)",
    switchLabel: "writing-tracker",
    targetLabel: "writing-tracker (abandoned Lovable app)",
    asset: {
      sampleData: IS_SAMPLE_DATA,
      report: WRITING_TRACKER_REPORT,
      story: WRITING_TRACKER_STORY,
    },
  },
  {
    id: "moodplays",
    title: "MoodPlays (revived Lovable app)",
    switchLabel: "MoodPlays",
    targetLabel: "MoodPlays (abandoned Lovable app)",
    asset: {
      sampleData: MOODPLAYS_IS_SAMPLE_DATA,
      report: MOODPLAYS_REPORT,
      story: MOODPLAYS_STORY,
    },
  },
];

async function main(): Promise<void> {
  const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(uiRoot, "public", "reports");
  await mkdir(outDir, { recursive: true });

  const entries: ReportManifestEntry[] = [];
  for (const { id, title, switchLabel, targetLabel, asset } of REPORTS) {
    const assetPath = reportAssetPath(id);
    const file = join(outDir, `${id}.json`);
    await writeFile(file, `${JSON.stringify(asset, null, 2)}\n`, "utf8");
    entries.push({
      id,
      title,
      switchLabel,
      targetLabel,
      path: assetPath,
      sampleData: asset.sampleData,
    });
    console.log(`exported ${assetPath}`);
  }

  const manifest: ReportManifest = { reports: entries };
  const manifestFile = join(outDir, "index.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`exported /reports/index.json (${entries.length} report(s))`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
