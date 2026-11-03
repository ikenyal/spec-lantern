/**
 * Static report-asset contract shared by the export step (task 19.1) and the
 * client-side loader.
 *
 * The Hosted_Demo is a STATIC site: it serves pre-generated Lantern_Reports as
 * JSON files that the UI fetches client-side (design: "serves one or more
 * pre-generated sample Lantern_Reports as static JSON/assets that the same
 * Lantern_Report_UI loads client-side"). This module defines WHERE those assets
 * live and WHAT shape they carry, with NO sample data imported here — so it is
 * safe to include in the library build. The actual (hand-authored) sample
 * report is serialized by `scripts/export-sample-report.ts`, which is the only
 * place that imports `sample-report.ts`.
 *
 * Data fidelity: this module never authors report rows. It only transports a
 * {@link LanternReport} that was produced elsewhere (currently the verified
 * sample in `sample-report.ts`; the real pipeline output in task 20) together
 * with the `sampleData` flag that drives the UI's "Sample data" badge.
 */
import type { LanternReport } from "@spec-lantern/types";

/**
 * Directory (relative to the site root) under which the exported report assets
 * are written and from which the UI fetches them. Vite serves `public/` at the
 * site root, so a file written to `public/reports/foo.json` is reachable at
 * `/reports/foo.json` both in `vite dev`/`vite preview` and in the built static
 * site deployed by the Hosted_Demo (task 19.2).
 */
export const REPORTS_BASE_PATH = "/reports";

/** Manifest file listing every exported report asset. */
export const REPORTS_MANIFEST_PATH = `${REPORTS_BASE_PATH}/index.json`;

/**
 * A single exported report asset: the {@link LanternReport} plus the
 * `sampleData` flag that tells the UI whether to show the "Sample data" badge.
 * Serialized verbatim to a JSON file; nothing is derived or invented on export.
 */
export interface ReportAsset {
  /** Whether this report is hand-authored sample data (drives the UI badge). */
  readonly sampleData: boolean;
  /** The pre-generated Lantern_Report to render. */
  readonly report: LanternReport;
}

/** One entry in the {@link ReportManifest}: an id, a title, and its asset URL. */
export interface ReportManifestEntry {
  /** Stable slug used in the asset filename (e.g. "writing-tracker"). */
  readonly id: string;
  /** Human-readable label for a report picker. */
  readonly title: string;
  /** Site-root-relative URL of the report asset JSON. */
  readonly path: string;
  /** Whether the report is hand-authored sample data. */
  readonly sampleData: boolean;
}

/**
 * The manifest the UI fetches first to discover which pre-generated reports are
 * available, so the demo can grow to more than one report without a rebuild of
 * the UI code (task 19.1 exports one; the shape already supports "one or more").
 */
export interface ReportManifest {
  readonly reports: readonly ReportManifestEntry[];
}

/** Build the site-root-relative URL of a report asset from its id. */
export function reportAssetPath(id: string): string {
  return `${REPORTS_BASE_PATH}/${id}.json`;
}
