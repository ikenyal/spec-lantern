/**
 * Runnable demo entry (packages/ui/index.html -> this file) and the exact same
 * code the static Hosted_Demo (task 19) ships.
 *
 * The demo contains NO runner and executes NO Target_Repo code. It fetches a
 * PRE-GENERATED report asset client-side (task 19.1) from `/reports` — the JSON
 * written by `scripts/export-sample-report.ts` into `public/reports/` and copied
 * verbatim into the built static site — and mounts <LanternReportView> with it.
 * The `sampleData` flag comes from the fetched asset. It is now REAL pipeline
 * output (src/real-report.ts), so `sampleData` is false and the "Sample data"
 * badge no longer shows. This file is demo-only wiring; it is excluded from the
 * library build and from the test glob.
 */
import { StrictMode, useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { LanternReportView } from "./components.js";
import { loadFirstReportAsset } from "./load-report.js";
import type { ReportAsset } from "./report-asset.js";
import "./lantern-theme.css";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; asset: ReportAsset | null }
  | { phase: "error"; message: string };

/**
 * Loads the first pre-generated report asset from `/reports` and renders it.
 * While loading or on error it falls back to the UI's own "no report exists"
 * state (R10.7) by passing a null report — no sample data is ever synthesized
 * here.
 */
function DemoApp(): ReactElement {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadFirstReportAsset((input) => fetch(input))
      .then((asset) => {
        if (!cancelled) setState({ phase: "ready", asset });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            phase: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "ready" && state.asset) {
    return (
      <LanternReportView
        report={state.asset.report}
        sampleData={state.asset.sampleData}
        story={state.asset.story}
      />
    );
  }

  // Loading and error both show the "no report" state; render is null-safe.
  return <LanternReportView report={null} />;
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Demo root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
);
