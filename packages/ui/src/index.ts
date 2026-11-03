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
  TEST_IDS,
  getUiRenderLimitSeconds,
  formatPredicted,
  formatActual,
  isMismatch,
  getCounterexample,
  safeStringify,
  extractExpectedActual,
  summarize,
  type ExpectedActual,
  type ReportSummary,
  type LanternReportViewProps,
  type PropertyTableProps,
  type PropertyRowProps,
  type ClaimHeroProps,
  type CounterexampleDetailProps,
  type TransitionDetailProps,
} from "./components.js";
