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
import {
  loadManifest,
  loadReportAsset,
  loadSectionsAsset,
} from "./load-report.js";
import type {
  ReportAsset,
  ReportManifestEntry,
  ReportSectionsAsset,
} from "./report-asset.js";
import "./lantern-theme.css";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; entries: readonly ReportManifestEntry[] }
  | { phase: "error"; message: string };

/**
 * Loads the manifest of pre-generated report assets from `/reports` and renders
 * a TARGET SWITCHER across them, fetching the selected report's asset on demand.
 * Each target is a real pipeline report (writing-tracker, MoodPlays). While
 * loading or on error it falls back to the UI's own "no report exists" state
 * (R10.7) with a null report — no sample data is ever synthesized here.
 */
function DemoApp(): ReactElement {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [asset, setAsset] = useState<ReportAsset | null>(null);
  const [sections, setSections] = useState<ReportSectionsAsset | null>(null);

  // 0. Load the build-time sections asset once (timelines + isolation +
  //    honesty). Absent -> null, so the three sections are simply omitted.
  useEffect(() => {
    let cancelled = false;
    loadSectionsAsset((input) => fetch(input))
      .then((s) => {
        if (!cancelled) setSections(s);
      })
      .catch(() => {
        if (!cancelled) setSections(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 1. Load the manifest once.
  useEffect(() => {
    let cancelled = false;
    loadManifest((input) => fetch(input))
      .then((manifest) => {
        if (cancelled) return;
        setState({ phase: "ready", entries: manifest.reports });
        setSelectedId(manifest.reports[0]?.id ?? null);
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

  // 2. Fetch the selected report's asset whenever the selection changes.
  useEffect(() => {
    if (state.phase !== "ready" || selectedId === null) return;
    const entry = state.entries.find((e) => e.id === selectedId);
    if (!entry) return;
    let cancelled = false;
    setAsset(null);
    loadReportAsset((input) => fetch(input), entry.path)
      .then((a) => {
        if (!cancelled) setAsset(a);
      })
      .catch(() => {
        if (!cancelled) setAsset(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state, selectedId]);

  if (state.phase !== "ready") {
    // Loading and error both show the "no report" state; render is null-safe.
    return <LanternReportView report={null} />;
  }

  const entries = state.entries;
  const selectedEntry = entries.find((e) => e.id === selectedId) ?? null;

  return (
    <>
      {entries.length > 1 ? (
        <nav
          className="lantern-switcher"
          data-testid="lantern-target-switcher"
          aria-label="Choose a target repo report"
        >
          <span className="lantern-switcher__label">Target:</span>
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="lantern-switcher__tab"
              data-active={entry.id === selectedId ? "true" : undefined}
              aria-pressed={entry.id === selectedId}
              onClick={() => setSelectedId(entry.id)}
            >
              {entry.switchLabel ?? entry.title}
            </button>
          ))}
        </nav>
      ) : null}
      <LanternReportView
        report={asset ? asset.report : null}
        sampleData={asset ? asset.sampleData : false}
        story={asset ? asset.story : undefined}
        targetLabel={selectedEntry?.targetLabel}
        sections={sections ?? undefined}
        targetId={selectedId ?? undefined}
      />
    </>
  );
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
