/**
 * Tests for the client-side static-report loader (task 19.1).
 *
 * The Hosted_Demo fetches pre-generated report JSON client-side rather than
 * importing it at build time. These tests exercise that fetch/parse path with
 * an injected `fetch` (no network, no runner) and assert the loader returns the
 * asset verbatim and surfaces failures.
 */
import { describe, it, expect } from "vitest";
import type { LanternReport } from "@spec-lantern/types";
import {
  loadFirstReportAsset,
  loadManifest,
  loadReportAsset,
  type FetchLike,
} from "./load-report.js";
import {
  REPORTS_MANIFEST_PATH,
  reportAssetPath,
  type ReportAsset,
  type ReportManifest,
} from "./report-asset.js";

const EMPTY_REPORT: LanternReport = {
  comparisons: [],
  observedDeviations: [],
  noConfirmedBug: true,
  noObservedDeviation: true,
  generatedAt: "2000-01-15T00:00:05.000+09:00",
};

/** Build a FetchLike that serves a fixed map of path -> JSON body. */
function fakeFetch(routes: Record<string, unknown>): FetchLike {
  return async (input: string) => {
    if (input in routes) {
      return {
        ok: true,
        status: 200,
        json: async () => routes[input],
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

describe("static report loader", () => {
  it("loads the manifest from the conventional path", async () => {
    const manifest: ReportManifest = {
      reports: [
        {
          id: "writing-tracker",
          title: "writing-tracker",
          path: reportAssetPath("writing-tracker"),
          sampleData: true,
        },
      ],
    };
    const fetchImpl = fakeFetch({ [REPORTS_MANIFEST_PATH]: manifest });

    expect(await loadManifest(fetchImpl)).toEqual(manifest);
  });

  it("loads a report asset verbatim", async () => {
    const asset: ReportAsset = { sampleData: true, report: EMPTY_REPORT };
    const path = reportAssetPath("writing-tracker");
    const fetchImpl = fakeFetch({ [path]: asset });

    expect(await loadReportAsset(fetchImpl, path)).toEqual(asset);
  });

  it("follows the manifest to fetch the first report asset", async () => {
    const path = reportAssetPath("writing-tracker");
    const manifest: ReportManifest = {
      reports: [
        { id: "writing-tracker", title: "wt", path, sampleData: true },
      ],
    };
    const asset: ReportAsset = { sampleData: true, report: EMPTY_REPORT };
    const fetchImpl = fakeFetch({
      [REPORTS_MANIFEST_PATH]: manifest,
      [path]: asset,
    });

    expect(await loadFirstReportAsset(fetchImpl)).toEqual(asset);
  });

  it("returns null when the manifest lists no reports", async () => {
    const manifest: ReportManifest = { reports: [] };
    const fetchImpl = fakeFetch({ [REPORTS_MANIFEST_PATH]: manifest });

    expect(await loadFirstReportAsset(fetchImpl)).toBeNull();
  });

  it("throws when the manifest cannot be fetched", async () => {
    const fetchImpl = fakeFetch({});
    await expect(loadManifest(fetchImpl)).rejects.toThrow(/manifest/);
  });

  it("throws when a report asset cannot be fetched", async () => {
    const fetchImpl = fakeFetch({});
    await expect(
      loadReportAsset(fetchImpl, reportAssetPath("missing")),
    ).rejects.toThrow(/report asset/);
  });
});
