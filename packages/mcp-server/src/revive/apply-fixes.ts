/**
 * The Revive loop — copy-and-apply mechanism (task 15.1, design Component 2
 * "Revive").
 *
 * This module realizes ONE half of the Revive loop: it makes a COPY of the
 * Target_Repo into a fresh Target_Repo_Copy and applies each Kiro-authored
 * Fix_Task ONLY to that copy, leaving the original Target_Repo byte-for-byte
 * unchanged. The re-execution + Property_Transition classification against the
 * copy is the SEPARATE next subtask (task 15.2, `apply_fixes_and_reexecute`);
 * this module deliberately stops at "the copy exists and the fixes have been
 * written into it" and hands back the copy's path for 15.2 to run against.
 *
 * WHY THIS IS A SEPARATE, PURE-ish MODULE. The design principle "the original
 * is sacred" (R8.2) is the core guarantee here: the user's Target_Repo must
 * never be mutated by a fix. The safest way to honor that is to make the
 * original UNREACHABLE by any write path in this module — we copy first, derive
 * the Target_Repo_Copy root, and every subsequent write is resolved and
 * CONFINED under that copy root (see {@link resolveInsideCopy}). There is no
 * code path in this module that opens the original for writing. A caller cannot
 * even express "edit the original" because the apply step only ever receives
 * the copy root.
 *
 * WHY A `FixApplication` CONTRACT (not just a `FixTask`). A {@link FixTask} from
 * `@spec-lantern/types` carries a Kiro-authored natural-language `description`
 * of the change — NOT a structured, machine-applicable patch. So "apply this
 * Fix_Task" needs a concrete, deterministic way to realize the change on the
 * copy. This module introduces a MINIMAL, serializable-friendly
 * {@link FixApplication} that pairs a `FixTask` with a small list of
 * {@link FileEdit}s (write-full-contents or delete, by repo-relative path). This
 * keeps the apply mechanism:
 *   - deterministic and testable (no LLM call at apply time — Kiro authored the
 *     edits up front, the MCP_Server just writes them),
 *   - serializable (plain JSON: paths + string contents), so it can cross the
 *     MCP boundary as the eventual `apply_fixes_and_reexecute` payload, and
 *   - confined (every edit path is validated to stay under the copy root).
 *
 * HOST-SAFETY DISCIPLINE. Copying files and editing files on the host's COPY
 * directory is a plain filesystem operation — it is NOT executing Target_Repo
 * code, so it is allowed on the host (unlike install/build/test, which belong
 * to the Isolated_Runner and happen only in 15.2). This module therefore does
 * NOT spawn any process, run any install/build/test, or touch the runner; it is
 * purely `cp` + write/delete under a throwaway copy directory. The one
 * invariant it enforces aggressively is boundary confinement: a {@link FileEdit}
 * whose path escapes the copy root (absolute, or `..`-climbing) is REJECTED
 * before any write, so a malformed/malicious edit can never reach the original
 * or anywhere else on the host.
 *
 * COPY LAYOUT. The copy excludes the same heavy/irrelevant directories the
 * walking-skeleton working copy excludes (`node_modules`, `.git`, `dist`,
 * `build`) so the copy is lean and the eventual in-runner install starts from a
 * clean tree. Excluding `node_modules` does NOT affect the byte-for-byte
 * guarantee on the ORIGINAL — we never write to the original at all; the
 * exclusion only shapes what the copy contains.
 */
import { cp, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FixTask } from "@spec-lantern/types";
import { WORKING_COPY_PARENT_DIR } from "../runner/working-copy.js";

/* -------------------------------------------------------------------------- */
/* The applyable-edit contract                                                */
/* -------------------------------------------------------------------------- */

/**
 * Directories excluded when copying the Target_Repo into the Target_Repo_Copy.
 *
 * Mirrors the walking-skeleton working-copy exclusions (see
 * {@link ../execute-path.ts}): `node_modules` is huge and will be reinstalled
 * cleanly in the runner (task 15.2), while `.git`, `dist`, and `build` are
 * irrelevant to re-execution. This shapes only the COPY — the original is never
 * written to regardless.
 */
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

/**
 * A single concrete file change to realize on the Target_Repo_Copy.
 *
 * A Fix_Task's `description` is natural language; a `FileEdit` is the
 * deterministic, serializable realization of (part of) that fix. Two kinds:
 *  - `write` — create or overwrite the file at `path` with `contents` (parent
 *    directories are created as needed).
 *  - `delete` — remove the file at `path` if it exists (idempotent).
 *
 * `path` is ALWAYS repo-relative (relative to the copy root) and POSIX-style.
 * It is validated to stay within the copy boundary before any write (R8.2 /
 * R12.6 confinement); an absolute path or one that climbs out with `..` is
 * rejected.
 */
export type FileEdit =
  | { kind: "write"; path: string; contents: string }
  | { kind: "delete"; path: string };

/**
 * A Fix_Task paired with the concrete {@link FileEdit}s that realize it on the
 * Target_Repo_Copy.
 *
 * This is the minimal applyable unit: the `fixTask` carries the identity and
 * the `appliesTo` guard (which MUST be `"Target_Repo_Copy"` — enforced at apply
 * time), and `edits` carry the actual file changes. Both halves are plain JSON,
 * so a `FixApplication[]` serializes directly as the eventual
 * `apply_fixes_and_reexecute` payload.
 */
export interface FixApplication {
  /** The Kiro-authored Fix_Task this application realizes. */
  fixTask: FixTask;
  /** The concrete file edits that realize the fix on the copy. */
  edits: FileEdit[];
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of copying the Target_Repo and applying every {@link
 * FixApplication} to the copy.
 *
 * Callers (task 15.2) use `targetRepoCopyPath` as the `targetRepoRef` of a
 * re-execution request. `appliedFixTaskIds` records which Fix_Tasks were
 * applied, in order, for traceability in the eventual report. The original
 * Target_Repo path is intentionally NOT returned as something to write to — it
 * is never written at all.
 */
export interface ApplyFixesResult {
  /** Absolute path to the freshly created Target_Repo_Copy (what 15.2 runs). */
  targetRepoCopyPath: string;
  /** The ids of the Fix_Tasks applied to the copy, in application order. */
  appliedFixTaskIds: string[];
  /** The total number of individual file edits written to the copy. */
  editsApplied: number;
}

/**
 * Options for {@link applyFixesToCopy}.
 */
export interface ApplyFixesOptions {
  /**
   * Where to root the Target_Repo_Copy. Defaults to a fresh `mkdtemp` under the
   * `/Users`-visible working-copy parent ({@link WORKING_COPY_PARENT_DIR}) — NOT
   * the OS temp dir, because the macOS Podman machine shares `/Users` but NOT
   * `/tmp`, so a copy under `tmpdir()` would be invisible inside the container
   * when the post-fix re-execution mounts it. Overridable so a test can place
   * the copy somewhere specific. A fresh, unique directory is always created
   * UNDER this location so two applies never collide and neither can touch the
   * original.
   */
  copyParentDir?: string;
  /** Optional progress sink (defaults to no-op). */
  log?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Boundary-confined path resolution                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a repo-relative edit `path` to an absolute path INSIDE `copyRoot`,
 * rejecting anything that would escape the copy boundary.
 *
 * This is the single chokepoint that makes "write into the copy only" true in
 * code: the returned path is guaranteed to be `copyRoot` itself or a descendant
 * of it, so no edit can reach the original Target_Repo, `$HOME`, or anywhere
 * else on the host (R8.2 / R12.6). An absolute `path`, or a relative one that
 * climbs out with `..`, throws before any filesystem write happens.
 *
 * @throws if `path` is absolute or resolves outside `copyRoot`.
 */
function resolveInsideCopy(copyRoot: string, path: string): string {
  if (isAbsolute(path)) {
    throw new Error(
      `FileEdit path must be repo-relative, got absolute path: ${path}`,
    );
  }
  const resolved = resolve(copyRoot, path);
  const rel = relative(copyRoot, resolved);
  // `rel` is "" when the path IS the copy root (not a file), or starts with ".."
  // / is absolute when it escapes the root — both are invalid edit targets.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `FileEdit path escapes the Target_Repo_Copy boundary: ${path}`,
    );
  }
  return resolved;
}

/* -------------------------------------------------------------------------- */
/* Copy the Target_Repo → Target_Repo_Copy                                    */
/* -------------------------------------------------------------------------- */

/**
 * Make a fresh COPY of the Target_Repo at `targetRepoPath` into a new
 * Target_Repo_Copy directory, WITHOUT mutating the original.
 *
 * The copy is created under a unique `mkdtemp` directory so repeated applies
 * never collide, and excludes {@link EXCLUDED_DIRS} so it stays lean. The source
 * is only ever READ (`cp` reads from it); the original is never opened for
 * writing here or anywhere else in this module.
 *
 * @param targetRepoPath absolute path to the original Target_Repo (read-only).
 * @param options copy-location override + log sink.
 * @returns the absolute path to the new Target_Repo_Copy root.
 */
export async function copyTargetRepo(
  targetRepoPath: string,
  options: ApplyFixesOptions = {},
): Promise<string> {
  const log = options.log ?? (() => undefined);
  const sourceAbs = resolve(targetRepoPath);

  const parent = options.copyParentDir
    ? resolve(options.copyParentDir)
    : WORKING_COPY_PARENT_DIR;
  // Ensure the parent exists (the /Users-visible skeleton dir, or a caller-
  // specified location).
  await mkdir(parent, { recursive: true });

  // Fresh, unique copy root. Nothing the original owns is ever written. The
  // `.worktree` prefix keeps the copy covered by the repo's `.worktree*`
  // gitignore when it lands under the default /Users-visible parent.
  const copyRoot = await mkdtemp(join(parent, ".worktree-fix-"));
  log(`Copying Target_Repo ${sourceAbs} → Target_Repo_Copy ${copyRoot}`);

  await cp(sourceAbs, copyRoot, {
    recursive: true,
    filter: (source) => {
      // `source` is an absolute path inside the original; exclude it if ANY of
      // its path segments (relative to the source root) is an excluded dir.
      const relToSource = source.slice(sourceAbs.length).replace(/^[/\\]/, "");
      if (relToSource === "") return true;
      const segments = relToSource.split(/[/\\]/);
      return !segments.some((segment) => EXCLUDED_DIRS.has(segment));
    },
  });

  return copyRoot;
}

/* -------------------------------------------------------------------------- */
/* Apply a single FileEdit to the copy                                        */
/* -------------------------------------------------------------------------- */

/**
 * Apply ONE {@link FileEdit} under `copyRoot`. The path is boundary-checked via
 * {@link resolveInsideCopy} before any write, so an escaping edit throws and the
 * copy (and the original) stay untouched for that edit.
 *
 * A `write` creates parent directories as needed and writes the full contents;
 * a `delete` removes the file if present (idempotent — a missing file is not an
 * error, matching "ensure this file is gone").
 */
async function applyEdit(copyRoot: string, edit: FileEdit): Promise<void> {
  const absPath = resolveInsideCopy(copyRoot, edit.path);
  if (edit.kind === "write") {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, edit.contents);
    return;
  }
  // delete — idempotent.
  await rm(absPath, { force: true });
}

/* -------------------------------------------------------------------------- */
/* The copy-and-apply entry point                                             */
/* -------------------------------------------------------------------------- */

/**
 * Copy the Target_Repo into a fresh Target_Repo_Copy and apply every
 * {@link FixApplication} to the COPY ONLY (task 15.1, R8.2).
 *
 * Flow:
 *  1. **Guard `appliesTo` FIRST (R8.2).** Before copying anything, assert that
 *     every Fix_Task's `appliesTo` is exactly `"Target_Repo_Copy"`. A Fix_Task
 *     declaring any other target is rejected — the `FixTask` type pins this to
 *     the literal, and we re-check at runtime so a hand-built/deserialized task
 *     that violates it never proceeds to touch the filesystem. This makes "fixes
 *     apply only to the copy" true by construction: there is no branch that
 *     applies to anything else.
 *  2. **Copy the original → a fresh copy ({@link copyTargetRepo}).** The
 *     original is only read; the copy is where all edits land.
 *  3. **Apply each application's edits to the copy**, in order. Every edit path
 *     is confined under the copy root ({@link resolveInsideCopy}); an escaping
 *     edit throws and no write reaches the original or elsewhere.
 *
 * The original Target_Repo is left byte-for-byte unchanged: this function never
 * opens it for writing, and the ONLY write target it ever computes is under the
 * copy root.
 *
 * NOTE: this performs NO install/build/test and spawns NO process — that is the
 * runner's job in task 15.2 (`apply_fixes_and_reexecute`). This stops at the
 * prepared copy and returns its path.
 *
 * @param targetRepoPath absolute path to the original Target_Repo (read-only).
 * @param applications the Fix_Tasks + their concrete edits to realize on the copy.
 * @param options copy-location override + log sink.
 * @returns the copy path, the applied Fix_Task ids, and the edit count.
 * @throws if any Fix_Task's `appliesTo` is not `"Target_Repo_Copy"`, or if any
 *   edit path escapes the copy boundary.
 */
export async function applyFixesToCopy(
  targetRepoPath: string,
  applications: readonly FixApplication[],
  options: ApplyFixesOptions = {},
): Promise<ApplyFixesResult> {
  const log = options.log ?? (() => undefined);

  // 1. Guard appliesTo BEFORE any filesystem work (R8.2). Reject the whole
  //    operation if any Fix_Task targets something other than the copy, so a
  //    bad task can never cause a write.
  for (const { fixTask } of applications) {
    assertAppliesToCopy(fixTask);
  }

  // 2. Copy the original into a fresh Target_Repo_Copy (original read-only).
  const copyRoot = await copyTargetRepo(targetRepoPath, options);

  // 3. Apply every edit to the COPY, confined under the copy root.
  const appliedFixTaskIds: string[] = [];
  let editsApplied = 0;
  for (const { fixTask, edits } of applications) {
    log(
      `Applying Fix_Task ${fixTask.id} (${edits.length} edit${
        edits.length === 1 ? "" : "s"
      }) to the Target_Repo_Copy`,
    );
    for (const edit of edits) {
      await applyEdit(copyRoot, edit);
      editsApplied += 1;
    }
    appliedFixTaskIds.push(fixTask.id);
  }

  return { targetRepoCopyPath: copyRoot, appliedFixTaskIds, editsApplied };
}

/**
 * Assert a {@link FixTask} targets the Target_Repo_Copy (R8.2). The `FixTask`
 * type already pins `appliesTo` to the `"Target_Repo_Copy"` literal; this is the
 * RUNTIME guard for values that crossed a serialization boundary (the MCP wire,
 * a hand-authored artifact) where the compile-time guarantee no longer holds.
 *
 * @throws if `fixTask.appliesTo` is not exactly `"Target_Repo_Copy"`.
 */
export function assertAppliesToCopy(fixTask: FixTask): void {
  if (fixTask.appliesTo !== "Target_Repo_Copy") {
    throw new Error(
      `Fix_Task ${fixTask.id} must apply to "Target_Repo_Copy" (R8.2), ` +
        `got: ${String(fixTask.appliesTo)}`,
    );
  }
}

/**
 * Remove a Target_Repo_Copy created by {@link applyFixesToCopy} / {@link
 * copyTargetRepo}. A convenience for callers/tests that are done with the copy;
 * safe to call on a missing path. Never touches anything outside the given copy
 * path.
 */
export async function cleanupTargetRepoCopy(copyPath: string): Promise<void> {
  await rm(copyPath, { recursive: true, force: true });
}
