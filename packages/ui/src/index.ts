/**
 * @spec-lantern/ui
 *
 * Home of the Lantern_Report_UI deliverable and the runnable demo
 * (packages/ui/index.html, served by `npm run dev -w @spec-lantern/ui`).
 * Components render a Lantern_Report showing predicted ("Kiro believed") vs
 * actual ("Execution proved") per property, with a mismatch indicator on rows
 * where the prediction disagrees with the executed result (task 18.1), plus
 * Counterexample / Property_Transition detail and the "no report" empty state
 * (task 18.2). The lantern design lives in ./lantern-theme.css.
 */
import { SPEC_LANTERN } from "@spec-lantern/types";

export const UI_FEATURE = SPEC_LANTERN;

/**
 * Lantern_Report_UI components (tasks 18.1, 18.2): the top-level
 * {@link LanternReportView}, the {@link PropertyTable} / {@link PropertyRow}
 * that lay predicted and actual out adjacently with a mismatch indicator, the
 * {@link CounterexampleDetail} / {@link TransitionDetail} cells that show a
 * Confirmed_Bug's Counterexample (or its unavailable indication) and a recorded
 * Property_Transition's pre/post-fix results, plus the presentation helpers,
 * the {@link summarize} header tally, `data-testid` builders, and the configured
 * render limit accessor. The top-level view also renders a "no report exists"
 * message when no report is available. See ./components.tsx for the full
 * contract.
 */
export {
  LanternReportView,
  PropertyTable,
  PropertyRow,
  CounterexampleDetail,
  TransitionDetail,
  TEST_IDS,
  getUiRenderLimitSeconds,
  formatPredicted,
  formatActual,
  isMismatch,
  getCounterexample,
  safeStringify,
  summarize,
  type ReportSummary,
  type LanternReportViewProps,
  type PropertyTableProps,
  type PropertyRowProps,
  type CounterexampleDetailProps,
  type TransitionDetailProps,
} from "./components.js";
