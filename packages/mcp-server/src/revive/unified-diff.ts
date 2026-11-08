/**
 * @spec-lantern/mcp-server — a line-ending-preserving unified-diff builder
 * (change 4).
 *
 * In the end-to-end trial, Kiro hand-wrote the diff of the fix it applied, which
 * is exactly the kind of transcription that can drift from what actually
 * changed. `apply_fixes_and_reexecute` now computes the REAL unified diff of the
 * edits it applied to the throwaway copy (before the copy is deleted) and
 * returns it, so the diff is observed, never authored (report-data-fidelity).
 *
 * WHY A SELF-CONTAINED BUILDER. We avoid adding a diff dependency. This is a
 * minimal, correct unified diff over whole files using the classic
 * Myers-style longest-common-subsequence (LCS) on LINES. It is sufficient for
 * presenting what a fix changed.
 *
 * LINE-ENDING PRESERVATION. A line's terminator is part of its content here: we
 * split on `\n` but KEEP any trailing `\r` on each line (so a CRLF file's lines
 * each end in `\r`), and we re-emit each diff line with its original ending.
 * The builder never normalizes CRLF↔LF, so a diff of a CRLF file shows `\r\n`.
 */
import { relative, isAbsolute } from "node:path";

/**
 * Split text into lines for diffing, PRESERVING each line's terminator.
 *
 * Unlike a plain `split("\n")`, every returned element retains its own line
 * ending (`\r\n`, `\n`, or none for a final unterminated line), so re-joining
 * them reproduces the exact bytes and the diff can show real `\r\n` endings.
 * Empty input yields an empty array (no lines).
 */
export function splitLinesPreservingEndings(text: string): string[] {
  if (text.length === 0) return [];
  // Match any run of non-newline chars followed by an optional `\r\n`/`\n`.
  const matches = text.match(/[^\n]*\n|[^\n]+$/g);
  return matches ?? [];
}

/** Compute the LCS table lengths for two line arrays (classic DP). */
function lcsLengths(a: readonly string[], b: readonly string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** One diff operation on a line (context, deletion, or insertion). */
interface DiffOp {
  kind: "context" | "del" | "add";
  line: string;
}

/** Produce the ordered diff operations between two line arrays via LCS. */
function diffOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const dp = lcsLengths(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "context", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "del", line: a[i++] });
  while (j < b.length) ops.push({ kind: "add", line: b[j++] });
  return ops;
}

/** Ensure a diff body line carries a terminator, without altering CRLF/LF. */
function withTrailingNewline(line: string): string {
  return line.endsWith("\n") ? line : `${line}\n`;
}

/**
 * Build a single-hunk unified diff for ONE file's change, preserving line
 * endings. `before`/`after` are the full file contents (either may be `""` to
 * represent a created or deleted file).
 *
 * The output uses standard `--- a/<path>` / `+++ b/<path>` headers, a single
 * `@@ -start,count +start,count @@` hunk covering the whole file, and `+`/`-`/
 * ` ` line prefixes. Each emitted line keeps its original terminator (so a CRLF
 * file's lines end in `\r\n`); a `\ No newline at end of file` marker is added
 * when a side's final line is unterminated. Returns `""` when `before ===
 * after` (no change to show).
 *
 * @param path repo-relative path shown in the headers.
 * @param before the original file contents (`""` for a newly created file).
 * @param after the post-edit contents (`""` for a deleted file).
 */
export function unifiedDiffForFile(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) return "";

  const aLines = splitLinesPreservingEndings(before);
  const bLines = splitLinesPreservingEndings(after);
  const ops = diffOps(aLines, bLines);

  const header =
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -${aLines.length === 0 ? "0,0" : `1,${aLines.length}`} ` +
    `+${bLines.length === 0 ? "0,0" : `1,${bLines.length}`} @@\n`;

  const body: string[] = [];
  for (const op of ops) {
    const prefix = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
    const hadNewline = op.line.endsWith("\n");
    body.push(`${prefix}${withTrailingNewline(op.line)}`);
    if (!hadNewline) {
      body.push("\\ No newline at end of file\n");
    }
  }

  return header + body.join("");
}

/**
 * Normalize an edit path to the repo-relative POSIX form shown in diff headers.
 * Absolute paths are made relative to `root`; `\` is converted to `/`.
 */
export function diffPathFor(root: string, editPath: string): string {
  const rel = isAbsolute(editPath) ? relative(root, editPath) : editPath;
  return rel.split("\\").join("/");
}
