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
 * Data fidelity: this script re-serializes EXISTING, verified report data
 * (currently the hand-authored {@link WRITING_TRACKER_REPORT}, held to the
 * report-data-fidelity bar in sample-report.ts). It invents nothing: the
 * `sampleData` flag comes straight from `IS_SAMPLE_DATA`, and the row content
 * is the report object unchanged. When task 20 feeds real pipeline output in,
 * only the imported source and the flag change — the export mechanism is the
 * same.
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
import { WRITING_TRACKER_REPORT, IS_SAMPLE_DATA } from "../src/sample-report.js";

/** A report to export: its slug id, title, and the data + sample flag. */
interface ExportableReport {
  readonly id: string;
  readonly title: string;
  readonly asset: ReportAsset;
}

/**
 * The reports to export. Currently the single verified writing-tracker sample;
 * the manifest shape already supports "one or more" so task 20 can append the
 * real pipeline output without changing the export code.
 */
const REPORTS: readonly ExportableReport[] = [
  {
    id: "writing-tracker",
    title: "writing-tracker (abandoned Lovable app)",
    asset: { sampleData: IS_SAMPLE_DATA, report: WRITING_TRACKER_REPORT },
  },
];

async function main(): Promise<void> {
  const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(uiRoot, "public", "reports");
  await mkdir(outDir, { recursive: true });

  const entries: ReportManifestEntry[] = [];
  for (const { id, title, asset } of REPORTS) {
    const assetPath = reportAssetPath(id);
    const file = join(outDir, `${id}.json`);
    await writeFile(file, `${JSON.stringify(asset, null, 2)}\n`, "utf8");
    entries.push({ id, title, path: assetPath, sampleData: asset.sampleData });
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
