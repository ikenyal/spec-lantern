/**
 * @spec-lantern/mcp-server — verbatim tool-result persistence (change 2).
 *
 * In the end-to-end trial, Kiro (with no access to this repo) had to hand-write
 * the results, comparisons, and diffs the tools produced — which introduced a
 * transcription error. The fix is to let every executing tool persist its OWN
 * raw result verbatim, so the on-disk evidence is exactly what the tool returned
 * and no hand-copying is ever needed (report-data-fidelity).
 *
 * This module is the single, dependency-light writer every tool uses when a
 * `specRoot` is given: it computes a filesystem-safe, sortable, UTC timestamp
 * filename, ensures `<specRoot>/results/` exists, writes the EXACT `result`
 * object as pretty JSON, and returns the absolute written path. It contains NO
 * tool logic — the handlers call it after producing their result and attach the
 * returned path to what they return.
 *
 * HOST SAFETY. This only writes JSON text to the spec's own `results/`
 * directory; it never executes anything.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The spec-relative directory every tool persists its verbatim result into.
 * A sibling of the spec's `claims.json`/`properties/`/`locks/` directories.
 */
export const RESULTS_DIR = "results" as const;

/**
 * Derive a filesystem-safe, sortable, UTC timestamp string from a `Date`.
 *
 * `Date.prototype.toISOString()` yields `YYYY-MM-DDTHH:MM:SS.mmmZ`; the `:` and
 * `.` characters are not safe on every filesystem (notably `:` on Windows / in
 * some tooling), so they are replaced with `-`, giving
 * `YYYY-MM-DDTHH-MM-SS-mmmZ`. The result stays lexicographically sortable in
 * chronological order (the fields are fixed-width and most-significant-first).
 */
export function utcStampForFilename(date: Date): string {
  return date.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

/**
 * Write `result` verbatim as pretty JSON to
 * `<specRoot>/results/<utc-stamp>-<toolName>.json`, creating the `results/`
 * directory if missing, and return the ABSOLUTE written path.
 *
 * The `result` object is serialized exactly as given — the caller persists the
 * RAW tool output (before annotating its own return value with the path), so
 * the file on disk is self-contained and faithful (report-data-fidelity). The
 * timestamp source is injectable via `now` so tests can pin the filename.
 *
 * @param specRoot the spec root whose `results/` directory receives the file.
 * @param toolName the exact MCP tool name (stamped into the filename).
 * @param result the exact object to persist verbatim.
 * @param now injectable clock (defaults to `() => new Date()`).
 * @returns the absolute path of the written file.
 */
export async function writeToolResult(
  specRoot: string,
  toolName: string,
  result: unknown,
  now: () => Date = () => new Date(),
): Promise<string> {
  const resultsDir = resolve(specRoot, RESULTS_DIR);
  await mkdir(resultsDir, { recursive: true });
  const stamp = utcStampForFilename(now());
  const filePath = resolve(resultsDir, `${stamp}-${toolName}.json`);
  await writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return filePath;
}
