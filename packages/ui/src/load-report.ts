/**
 * Client-side loader for the pre-generated static report assets (task 19.1).
 *
 * The Hosted_Demo ships no runner and imports no report at build time; instead
 * the UI FETCHES the exported JSON at runtime. This loader reads the manifest
 * ({@link REPORTS_MANIFEST_PATH}), then fetches the first listed report asset
 * ({@link ReportAsset}) and returns it to the UI. Everything it returns comes
 * straight from the exported JSON — it never synthesizes report rows or flips
 * the `sampleData` flag.
 */
import {
  REPORTS_MANIFEST_PATH,
  TIMELINE_ASSET_PATH,
  type ReportAsset,
  type ReportManifest,
  type ReportSectionsAsset,
} from "./report-asset.js";

/** Minimal `fetch` surface this loader needs, so it is easy to test/inject. */
export type FetchLike = (input: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/** Fetch and parse the report manifest. Throws on a non-OK response. */
export async function loadManifest(
  fetchImpl: FetchLike,
  manifestPath: string = REPORTS_MANIFEST_PATH,
): Promise<ReportManifest> {
  const res = await fetchImpl(manifestPath);
  if (!res.ok) {
    throw new Error(
      `Failed to load report manifest ${manifestPath} (status ${res.status})`,
    );
  }
  return (await res.json()) as ReportManifest;
}

/** Fetch and parse a single report asset at `path`. Throws on a non-OK response. */
export async function loadReportAsset(
  fetchImpl: FetchLike,
  path: string,
): Promise<ReportAsset> {
  const res = await fetchImpl(path);
  if (!res.ok) {
    throw new Error(`Failed to load report asset ${path} (status ${res.status})`);
  }
  return (await res.json()) as ReportAsset;
}

/**
 * Fetch and parse the build-time-generated sections asset (the "Behind the
 * lantern" timelines, the isolation diagram, and the honesty items) from
 * {@link TIMELINE_ASSET_PATH}. Returns `null` when the asset is absent (a
 * non-OK response) so the UI simply omits the three sections rather than
 * failing — nothing here is synthesized.
 */
export async function loadSectionsAsset(
  fetchImpl: FetchLike,
  path: string = TIMELINE_ASSET_PATH,
): Promise<ReportSectionsAsset | null> {
  const res = await fetchImpl(path);
  if (!res.ok) return null;
  return (await res.json()) as ReportSectionsAsset;
}

/**
 * Load the first pre-generated report asset the manifest lists, the way the
 * demo page does it: read the manifest, then fetch the first entry's asset.
 * Returns `null` when the manifest lists no reports so the UI can fall back to
 * its "no report exists" state (R10.7).
 */
export async function loadFirstReportAsset(
  fetchImpl: FetchLike,
): Promise<ReportAsset | null> {
  const manifest = await loadManifest(fetchImpl);
  const first = manifest.reports[0];
  if (!first) return null;
  return loadReportAsset(fetchImpl, first.path);
}
