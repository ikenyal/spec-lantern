/**
 * Static report-asset contract shared by the export step (task 19.1) and the
 * client-side loader.
 *
 * The Hosted_Demo is a STATIC site: it serves pre-generated Lantern_Reports as
 * JSON files that the UI fetches client-side (design: "serves one or more
 * pre-generated sample Lantern_Reports as static JSON/assets that the same
 * Lantern_Report_UI loads client-side"). This module defines WHERE those assets
 * live and WHAT shape they carry, with NO sample data imported here — so it is
 * safe to include in the library build. The real pipeline report is serialized
 * by `scripts/export-sample-report.ts`, which is the only place that imports
 * the report data module (`src/real-report.ts`).
 *
 * Data fidelity: this module never authors report rows. It only transports a
 * {@link LanternReport} produced by the pipeline (src/real-report.ts, assembled
 * from the writing-tracker-full execution artifacts) together with the
 * `sampleData` flag that drives the UI's "Sample data" badge (now false).
 */
import type { LanternReport } from "@spec-lantern/types";

/**
 * The headline "story" for a report — the narrative above the property table
 * that walks a viewer through the single most important finding
 * (predict → lock → execute → revive).
 *
 * Every field is a VERBATIM copy of a persisted pipeline artifact (lock file,
 * stage-c / stage-d results, fix diff); nothing here is derived or invented
 * (report-data-fidelity). It is OPTIONAL: a report asset with no `story` simply
 * renders the table with no narrative, so existing/other reports are
 * unaffected. The UI never fabricates a story from the report alone — the
 * fields that are not in {@link LanternReport} (the lock hash + time, the fix
 * diff, the replay flag) travel here, sourced straight from disk.
 */
export interface LanternStory {
  /** The propertyId of the Confirmed_Bug this story is about. */
  readonly propertyId: string;
  /** One-line thesis shown at the very top of the story. */
  readonly thesis: string;
  /** Header stat line, e.g. "3 comments checked · 1 lie · …". */
  readonly stats: string;
  /** Step 1 — the lying comment, verbatim, and where it lives. */
  readonly comment: {
    readonly claimText: string;
    readonly sourceLocation: string;
  };
  /** Step 2 — Kiro's locked prediction (recorded before any execution). */
  readonly prediction: {
    readonly verdict: string;
    /** ISO timestamp from the Prediction_Lock (lockedAt). */
    readonly lockedAt: string;
    /** Short (display) form of the lock's contentHash. */
    readonly shortHash: string;
  };
  /** Step 3 — what the isolated execution actually produced. */
  readonly execution: {
    /** The fixed clock the rendered component ran under (from the run). */
    readonly clock: string;
    /** Timezone the run pinned. */
    readonly timezone: string;
    /** The expected first row the claim promised (e.g. "Jan 2000"). */
    readonly expectedFirstRow: string;
    /** The first row execution actually produced (e.g. "Aug 1999"). */
    readonly actualFirstRow: string;
    /** The six month labels, in the ORDER the buggy code rendered them. */
    readonly monthsAsRendered: readonly string[];
    /** One-line user impact. */
    readonly userImpact: string;
  };
  /** Step 4 — the revive: the fix, the transition, and reproducibility. */
  readonly revive: {
    /** The minimal fix diff, verbatim. */
    readonly diff: string;
    readonly preFixResult: string;
    readonly postFixResult: string;
    /** Human summary that the other claims still pass. */
    readonly otherClaimsStatus: string;
    /** From replay_counterexample: the same failure reproduces. */
    readonly reproducesSameFail: boolean;
  };
}

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
  /**
   * Optional headline story shown above the table. Omitted for reports with no
   * single lead finding. See {@link LanternStory} — every field is a verbatim
   * copy of a persisted pipeline artifact.
   */
  readonly story?: LanternStory;
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
