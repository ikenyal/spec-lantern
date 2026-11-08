/**
 * @spec-lantern/ui
 *
 * Home of the Lantern_Report_UI deliverable and the runnable demo
 * (packages/ui/index.html, served by `npm run dev -w @spec-lantern/ui`).
 * Components render a Lantern_Report that makes the lying Claim the hero of
 * each row — the original code comment quoted with its source location — and
 * contrasts predicted ("Kiro believed") vs actual ("Execution proved") with a
 * mismatch indicator where they disagree (task 18.1), plus Counterexample
 * evidence, Property_Transition detail, and the "no report" empty state
 * (task 18.2). The lantern design lives in ./lantern-theme.css.
 */
import { SPEC_LANTERN } from "@spec-lantern/types";

export const UI_FEATURE = SPEC_LANTERN;

/**
 * Lantern_Report_UI components (tasks 18.1, 18.2): the top-level
 * {@link LanternReportView}, the {@link PropertyTable} / {@link PropertyRow},
 * the {@link ClaimHero} that headlines the lying Claim, the
 * {@link CounterexampleDetail} / {@link TransitionDetail} cells (evidence card
 * with an Expected-vs-Actual contrast + collapsible raw details, and the
 * tombstone→lantern "Revived" marker), plus the presentation helpers
 * ({@link extractExpectedActual}, {@link summarize}, …), `data-testid`
 * builders, and the configured render limit accessor. See ./components.tsx for
 * the full contract.
 */
export {
  LanternReportView,
  PropertyTable,
  PropertyRow,
  ClaimHero,
  CounterexampleDetail,
  TransitionDetail,
  StorySection,
  BehindTheLanternSection,
  HowItStaysSafeSection,
  SameStandardSection,
  ReportSections,
  TryItSection,
  ReportFooter,
  TEST_IDS,
  getUiRenderLimitSeconds,
  formatPredicted,
  formatActual,
  isMismatch,
  hasNoLockedPrediction,
  getCounterexample,
  safeStringify,
  extractExpectedActual,
  summarize,
  countLies,
  countRevived,
  formatLieCount,
  type ExpectedActual,
  type ReportSummary,
  type LanternReportViewProps,
  type PropertyTableProps,
  type PropertyRowProps,
  type ClaimHeroProps,
  type CounterexampleDetailProps,
  type TransitionDetailProps,
  type StorySectionProps,
  type BehindTheLanternSectionProps,
  type HowItStaysSafeSectionProps,
  type SameStandardSectionProps,
  type ReportSectionsProps,
  type ReportFooterProps,
} from "./components.js";

/**
 * Static report-asset contract and client-side loader (task 19.1). The
 * Hosted_Demo serves pre-generated Lantern_Reports as JSON under
 * {@link REPORTS_BASE_PATH} and the UI fetches them at runtime via
 * {@link loadFirstReportAsset}; nothing is imported at build time and no
 * Target_Repo code runs. See ./report-asset.ts and ./load-report.ts.
 */
export {
  REPORTS_BASE_PATH,
  REPORTS_MANIFEST_PATH,
  TIMELINE_ASSET_PATH,
  GITHUB_COMMIT_BASE,
  reportAssetPath,
  commitUrl,
  formatUtc,
  type ReportAsset,
  type ReportManifest,
  type ReportManifestEntry,
  type LanternStory,
  type ReportSectionsAsset,
  type TargetTimeline,
  type TimelineStep,
  type TimelinePhase,
  type IsolationModel,
  type IsolationPhase,
  type IsolationGuarantee,
  type HonestyItem,
  type VerdictMismatch,
  type HarnessRevisions,
  type HarnessRevisionTiming,
} from "./report-asset.js";
export {
  loadManifest,
  loadReportAsset,
  loadFirstReportAsset,
  loadSectionsAsset,
  type FetchLike,
} from "./load-report.js";
