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
  /**
   * The page headline — the PRODUCT thesis, shared across every target (Kiro
   * predicts, then executes, then proves). Rendered as the largest text.
   */
  readonly thesis: string;
  /**
   * Optional target-specific one-liner shown BELOW the shared thesis (e.g. the
   * MoodPlays "check for 24 hours vs the characters 24" sentence). Omitted for a
   * target whose thesis already is its specific lead (writing-tracker).
   */
  readonly subhead?: string;
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
    /** The fixed clock the component/function ran under (from the run). */
    readonly clock: string;
    /** Timezone the run pinned. */
    readonly timezone: string;
    /**
     * The expected first row the claim promised (e.g. "Jan 2000"). Optional —
     * only the writing-tracker monthly story uses the first-row framing.
     */
    readonly expectedFirstRow?: string;
    /** The first row execution actually produced (e.g. "Aug 1999"). Optional. */
    readonly actualFirstRow?: string;
    /**
     * The month labels, in the ORDER the buggy code rendered them. Optional —
     * only the writing-tracker monthly story renders a month-table mock.
     */
    readonly monthsAsRendered?: readonly string[];
    /**
     * Generic evidence lines for a story with no month-table mock (e.g. the
     * MoodPlays counterexamples). Each is a short, verbatim-sourced line such as
     * `"\"00:00-13:24\" → closing time 13:24 dropped (treated as open 24h)"`.
     * Optional; rendered as a small list when present.
     */
    readonly evidenceLines?: readonly string[];
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
  /**
   * Optional attribution for the target repo (e.g. "MoodPlays by Gargi Sahu
   * (MIT)"). Rendered as a small credit line under the story.
   */
  readonly credit?: string;
  /**
   * Optional "how this target was chosen" note with a link to the selection
   * doc. Rendered as a small note under the story.
   */
  readonly selection?: {
    readonly note: string;
    /** Repo-relative path to the selection doc (shown as a link/label). */
    readonly docPath: string;
  };
}

/* -------------------------------------------------------------------------- */
/* "Behind the lantern" timeline (shared across targets, per-target rows)     */
/* -------------------------------------------------------------------------- */

/**
 * The canonical repo on GitHub. A commit short hash is linked to
 * `${GITHUB_COMMIT_BASE}<hash>` so a reader can open the exact commit that
 * recorded a step. Kept as a constant (not hand-typed per row) so every link
 * is built the same way.
 */
export const GITHUB_COMMIT_BASE =
  "https://github.com/ikenyal/spec-lantern/commit/";

/** Build the canonical GitHub URL for a commit short (or full) hash. */
export function commitUrl(hash: string): string {
  return `${GITHUB_COMMIT_BASE}${hash}`;
}

/**
 * Normalize any ISO timestamp (whatever its original offset — the lock/result
 * files are UTC `Z`, but git commit dates carry a `+09:00` offset) to a SINGLE
 * UTC display format: `YYYY-MM-DD HH:MM:SS UTC`. Used for every displayed time
 * in the timeline so the steps read in the correct order at a glance; the raw
 * value is still kept verbatim in the `<time datetime>` attribute. Returns the
 * input unchanged when it is not a parseable date (never throws).
 */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  );
}

/** The fixed ordered phases of the "Behind the lantern" timeline. */
export type TimelinePhase =
  | "predictions-locked"
  | "lock-commit"
  | "execution"
  | "replay-reproduced"
  | "fix"
  | "regression-check";

/**
 * One step in a target's "Behind the lantern" timeline. Every field is
 * GENERATED by {@link ../scripts/generate-timeline.ts} at build time from a
 * real source — a git commit, a lock file's `lockedAt`, or a result file's
 * `capturedAt` — never hand-typed (report-data-fidelity). A step with no
 * recorded commit (e.g. the lock `lockedAt` itself) simply omits `commit`.
 */
export interface TimelineStep {
  /** Which fixed phase this step is. */
  readonly phase: TimelinePhase;
  /** Short human label, e.g. "Predictions locked". */
  readonly label: string;
  /**
   * ISO timestamp for the step. Sourced from a lock file's `lockedAt`, a
   * result file's `capturedAt`, or the git commit date — whichever defines the
   * step. Omitted only when no timestamp defines the step.
   */
  readonly at?: string;
  /** The git commit short hash that recorded this step, when one applies. */
  readonly commit?: string;
  /** The git commit subject line, for context next to the hash. */
  readonly commitSubject?: string;
  /** A short, verbatim-sourced detail line (e.g. the lock short hash). */
  readonly detail?: string;
}

/**
 * A superseded lock whose verdict does NOT equal the active lock's verdict for
 * the same property — a data-integrity flag. A re-lock is only allowed to
 * change the hashed property source, never the predicted verdict (the predicted
 * verdict carries over verbatim), so a non-empty list means something is wrong
 * and the generator surfaces it rather than hiding it.
 */
export interface VerdictMismatch {
  readonly propertyId: string;
  readonly activeVerdict: string;
  readonly supersededVerdict: string;
}

/**
 * When the test-harness revisions (the re-locks whose old locks live in
 * `locks/superseded/`) happened RELATIVE to execution. This is a prose fact
 * recorded verbatim in each target's `locks/superseded/README.md` — it cannot
 * be derived from timestamps alone (a re-lock time can precede the persisted
 * single-source execution run even when a FIRST run already happened), so it is
 * carried here with a link to that README for the reader to verify.
 *   - "before-any-execution": all revisions were made by review before any run
 *     (MoodPlays: 5 tautological oracles rewritten before Stage C).
 *   - "after-first-run": a first run exposed harness defects, which were then
 *     revised and re-locked (writing-tracker: 2 harness defects).
 */
export type HarnessRevisionTiming = "before-any-execution" | "after-first-run";

/**
 * The test-harness revision summary for a target: how many property harnesses
 * were revised and re-locked (verdicts unchanged), WHEN that happened relative
 * to execution, and the README that records it verbatim. Present only when the
 * target has a `locks/superseded/` directory with superseded locks.
 */
export interface HarnessRevisions {
  /** How many property harnesses were revised + re-locked. */
  readonly count: number;
  /** When the revisions happened relative to execution (from the README). */
  readonly timing: HarnessRevisionTiming;
  /** One-line, verbatim-sourced statement of the timing for display. */
  readonly timingNote: string;
  /** Repo-relative path to the superseded-locks README. */
  readonly readmePath: string;
}

/**
 * The per-target "Behind the lantern" timeline: the ordered steps from
 * predictions-locked through the regression check, plus the honesty metadata
 * about prediction locks and harness revisions.
 *
 * The headline point — `predictionsLockedBeforeExecution` — is COMPUTED by the
 * generator as `latest active lockedAt < earliest execution capturedAt`, never
 * asserted by hand. Using the LATEST active lock (not the earliest) means the
 * claim holds only when EVERY active prediction was locked before execution.
 */
export interface TargetTimeline {
  /** Target id (matches a {@link ReportManifestEntry.id}). */
  readonly id: string;
  /** Human label for the target. */
  readonly label: string;
  /** The ordered timeline steps. */
  readonly steps: readonly TimelineStep[];
  /**
   * True when the LATEST active prediction lock precedes the EARLIEST execution
   * — i.e. every predicted verdict was locked before any execution. Computed
   * from the timestamps, not asserted.
   */
  readonly predictionsLockedBeforeExecution: boolean;
  /**
   * Any superseded lock whose verdict differs from its active lock's verdict
   * for the same property. Empty in a healthy repo (a re-lock never changes the
   * predicted verdict); surfaced so a mismatch is flagged, never hidden.
   */
  readonly verdictMismatches: readonly VerdictMismatch[];
  /**
   * The test-harness revision summary, present only when the target has
   * superseded locks. Reported SEPARATELY from the prediction-lock claim so the
   * two are not conflated: predicted verdicts are locked before execution;
   * harness revisions are a distinct event whose timing is stated honestly.
   */
  readonly harnessRevisions?: HarnessRevisions;
}

/**
 * The three extra report sections shown below the story and above the table.
 * All of it is GENERATED at build time (the timelines from git + lock/result
 * files; the isolation and honesty items are static descriptions of what the
 * code does, carried here so the UI never hard-codes them). Written to
 * {@link TIMELINE_ASSET_PATH} by {@link ../scripts/generate-timeline.ts}.
 */
export interface ReportSectionsAsset {
  /** When this asset was generated (ISO). */
  readonly generatedAt: string;
  /** The canonical GitHub commit URL base (so the UI links consistently). */
  readonly commitBase: string;
  /** One "Behind the lantern" timeline per target. */
  readonly timelines: readonly TargetTimeline[];
  /** The two-phase isolation diagram ("How it stays safe"). */
  readonly isolation: IsolationModel;
  /** The "We hold ourselves to the same standard" items. */
  readonly honesty: readonly HonestyItem[];
}

/* -------------------------------------------------------------------------- */
/* "How it stays safe" — two-phase isolation (shared)                         */
/* -------------------------------------------------------------------------- */

/** A single enforced guarantee in one isolation phase. */
export interface IsolationGuarantee {
  /** Short text describing exactly what the code does. */
  readonly text: string;
  /** Where in the runner source this is enforced (file, for traceability). */
  readonly source: string;
}

/** One phase of the two-phase execution lifecycle. */
export interface IsolationPhase {
  /** Phase id. */
  readonly id: "install" | "test";
  /** Phase title, e.g. "Install phase". */
  readonly title: string;
  /** One-line summary of the phase's network posture. */
  readonly summary: string;
  /** The enforced guarantees in this phase. */
  readonly guarantees: readonly IsolationGuarantee[];
}

/**
 * The two-phase isolation model plus the cross-cutting guarantees (Safety Gate,
 * read-only target, throwaway copy). Each line DESCRIBES what the runner source
 * actually does; the `source` fields trace every claim to a file.
 */
export interface IsolationModel {
  readonly phases: readonly IsolationPhase[];
  /** Guarantees that hold across both phases (gate, read-only, copy). */
  readonly crossCutting: readonly IsolationGuarantee[];
}

/* -------------------------------------------------------------------------- */
/* "We hold ourselves to the same standard" (shared)                          */
/* -------------------------------------------------------------------------- */

/**
 * One self-accountability item. Each links to its commit or file via
 * {@link href} (a GitHub commit URL for a commit, or a repo-relative path for a
 * file). The text describes a real event; the link is its evidence.
 */
export interface HonestyItem {
  /** Short title, e.g. "Our own Safety Gate had a bypass". */
  readonly title: string;
  /** One or two sentence description of what happened. */
  readonly body: string;
  /** Human label for the link (commit hash or file path). */
  readonly linkLabel: string;
  /** The href: a commit URL or a repo-relative file path. */
  readonly href: string;
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
 * The build-time-generated sections asset ("Behind the lantern" timelines, the
 * isolation diagram, and the honesty items), fetched by the UI alongside the
 * report. Written by {@link ../scripts/generate-timeline.ts}.
 */
export const TIMELINE_ASSET_PATH = `${REPORTS_BASE_PATH}/sections.json`;

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
  /** Short label for the target switcher tab (e.g. "writing-tracker"). */
  readonly switchLabel?: string;
  /** Human label for the report header ("Target: <targetLabel>"). */
  readonly targetLabel?: string;
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
