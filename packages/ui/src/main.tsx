/**
 * Runnable demo entry (packages/ui/index.html -> this file).
 *
 * Mounts <LanternReportView> with the real writing-tracker sample report so the
 * design can be opened in a browser via `npm run dev -w @spec-lantern/ui`. The
 * report is hand-authored sample data (see sample-report.ts), so `sampleData`
 * is passed from `IS_SAMPLE_DATA` to surface the "Sample data" badge until task
 * 20 wires in the real pipeline output. This file is demo-only wiring; it is
 * excluded from the library build and from the test glob.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LanternReportView } from "./components.js";
import { WRITING_TRACKER_REPORT, IS_SAMPLE_DATA } from "./sample-report.js";
import "./lantern-theme.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Demo root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <LanternReportView
      report={WRITING_TRACKER_REPORT}
      sampleData={IS_SAMPLE_DATA}
    />
  </StrictMode>,
);
