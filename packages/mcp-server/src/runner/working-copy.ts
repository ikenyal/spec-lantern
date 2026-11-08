/**
 * The throwaway, Podman-visible WORKING COPY the runner mounts (safety fix).
 *
 * WHY THIS MODULE EXISTS. The product's central promise — stated on the site
 * and in steering 00 — is that the Target_Repo is **read-only**: analyzing an
 * app must never mutate the user's own repo. But the runner's
 * Dependency_Install_Phase ({@link ./install-phase.ts}) runs
 * `npm install --ignore-scripts` INSIDE whatever directory it is handed, which
 * writes `node_modules/` and rewrites `package.json` / `package-lock.json` in
 * that directory. The test phase ({@link ./test-phase.ts}) additionally stages
 * a seed/clock config and (for an external property file) a temp dir into the
 * mount. So if `execute_properties` / `replay_counterexample` mount the
 * ORIGINAL `targetRepoRef` in place, those writes land in the user's repo — the
 * exact leak an end-to-end trial of the packaged Power found.
 *
 * The fix is the same one {@link ../revive/apply-fixes.ts} already uses for
 * `apply_fixes_and_reexecute`: never mount the original. Copy the Target_Repo
 * into a FRESH throwaway working copy (excluding `node_modules`, `.git`, build
 * output), optionally stage the property test files INTO that copy, mount the
 * COPY, and remove it afterwards. This module is the single shared realization
 * of that copy so `execute_properties`, `replay_counterexample`, and
 * `apply_fixes_and_reexecute` all stay byte-for-byte safe the same way.
 *
 * macOS VISIBILITY (hard constraint). The copy MUST live under the repo (under
 * `/Users`) and NEVER under host `/tmp`: the macOS Podman machine shares
 * `/Users` but not `/tmp`, so a copy under `tmpdir()` is invisible inside the
 * container. The default copy parent is therefore
 * `packages/mcp-server/skeleton/` (the same `/Users`-visible, gitignored
 * location the walking-skeleton working copy uses), with a `.worktree`-prefixed,
 * per-run-unique name so the existing `.worktree*` gitignore covers it and two
 * concurrent runs never collide.
 *
 * HOST-SAFETY. Copying and staging files on the host COPY is plain filesystem
 * work — it is NOT executing Target_Repo code, so it is allowed on the host
 * (install/build/test still happen ONLY in the container). This module spawns
 * no process and never writes anything outside the copy root or reads anything
 * from the original except to copy OUT of it.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  propertyTestFileName,
  parsePropertyTestFileName,
  ARTIFACT_PATHS,
} from "@spec-lantern/types";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Directories excluded when copying the Target_Repo into a working copy.
 * `node_modules` is reinstalled cleanly in the container; `.git`, `dist`, and
 * `build` are irrelevant to re-execution. This shapes only the COPY — the
 * original is never written to regardless of what is excluded.
 */
export const WORKING_COPY_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
]);

/**
 * The repo-relative working-copy parent (the walking-skeleton location, whose
 * `.worktree*` gitignore pattern covers these copies). This is resolved from the
 * compiled module (`dist/runner` → `../../skeleton`) and is CORRECT only when the
 * server runs from inside this repo's checkout. The PACKAGED bundle runs via
 * `npx` from the npm cache, where that relative path lands in a confusing place
 * inside the cache (and is not reliably Podman-visible). So this is NOT the
 * production default — it is exported only so the repo's OWN tests can pin copies
 * to the in-repo, gitignored location when they want to. The production default
 * is {@link WORKING_COPY_PARENT_DIR}.
 */
export const REPO_WORKING_COPY_PARENT_DIR = resolve(here, "..", "..", "skeleton");

/**
 * The default parent that HOLDS per-run working copies.
 *
 * It MUST live somewhere the macOS Podman machine can bind-mount — Podman shares
 * the user's home (`/Users/...`) but NOT the host `/tmp` — and it MUST be the
 * same place whether the server runs from this repo's checkout OR from the
 * packaged bundle launched via `npx` out of the npm cache. Resolving relative to
 * the server file fails the second case (copies land inside the npm cache). So
 * the default is anchored to the user's HOME:
 *   - `SPEC_LANTERN_WORKDIR` when set (explicit override), else
 *   - `~/.spec-lantern/worktrees`.
 * The directory is created on demand (see {@link ensureParentDir}). `homedir()`
 * is always under `/Users` on macOS, so the copy is visible inside the Podman VM.
 */
export const WORKING_COPY_PARENT_DIR = resolve(
  process.env.SPEC_LANTERN_WORKDIR?.trim()
    ? process.env.SPEC_LANTERN_WORKDIR.trim()
    : join(homedir(), ".spec-lantern", "worktrees"),
);

/** Base name every per-run working copy starts with. */
const WORKING_COPY_BASENAME = ".worktree";

/**
 * One property to (optionally) stage into the working copy, identified the way
 * a {@link PropertyExecutionRequest}'s properties are: by the `property-{n}.{claimId}`
 * stem id. The source file is read from the spec root's `properties/` dir; it
 * is written into the copy at the SAME `properties/`-relative path so the
 * runner's in-mount resolution (and any `@`-alias config the target carries)
 * sees it exactly where a property authored in the repo would be.
 */
export interface WorkingCopyProperty {
  /** The property id (`property-{n}.{claimId}` stem). */
  id: string;
}

/** Options for {@link prepareWorkingCopy}. */
export interface PrepareWorkingCopyOptions {
  /**
   * Where to root the working copy. Defaults to a fresh unique dir under
   * {@link WORKING_COPY_PARENT_DIR}. Overridable (tests) but still created fresh
   * and removed by {@link cleanupWorkingCopy}.
   */
  workingCopyDir?: string;
  /**
   * Optional spec root. When provided together with `properties`, the tool
   * itself stages each `properties/property-{n}.{claimId}.test.ts` from the spec
   * root INTO the copy so callers do not have to place the files by hand.
   */
  specRoot?: string;
  /** The properties whose test files to stage from `specRoot` (when set). */
  properties?: readonly WorkingCopyProperty[];
  /** Optional progress sink (defaults to no-op). */
  log?: (message: string) => void;
}

/** The prepared working copy a caller mounts. */
export interface PreparedWorkingCopy {
  /** Absolute path to the fresh working copy (the ONE dir to mount). */
  workingCopyDir: string;
}

/**
 * Build a UNIQUE per-run working-copy directory path under
 * {@link WORKING_COPY_PARENT_DIR} (`~/.spec-lantern/worktrees` by default, or the
 * `SPEC_LANTERN_WORKDIR` override). A per-run random token makes every run's copy
 * disjoint so concurrent runs cannot clobber each other mid-copy. The `.worktree`
 * prefix is kept for continuity (and so a copy pinned to the in-repo parent is
 * still covered by the repo's `.worktree*` gitignore).
 */
function makeUniqueWorkingCopyDir(): string {
  const token = randomBytes(6).toString("hex");
  return resolve(WORKING_COPY_PARENT_DIR, `${WORKING_COPY_BASENAME}-${token}`);
}

/**
 * Copy the Target_Repo at `targetRepoPath` into a FRESH throwaway working copy
 * (excluding {@link WORKING_COPY_EXCLUDED_DIRS}) and, when a `specRoot` +
 * `properties` are given, stage each property's test file from the spec root's
 * `properties/` dir INTO the copy at the same relative path.
 *
 * The original is only ever READ (`cp` reads from it); it is never opened for
 * writing. Returns the copy path for the caller to mount; the caller owns
 * teardown via {@link cleanupWorkingCopy} (typically in a `finally`).
 *
 * @throws if `specRoot` is given but a requested property's id does not follow
 *   the `property-{n}.{claimId}` convention (so a bad id can never silently skip
 *   staging and run an empty copy).
 */
export async function prepareWorkingCopy(
  targetRepoPath: string,
  options: PrepareWorkingCopyOptions = {},
): Promise<PreparedWorkingCopy> {
  const log = options.log ?? (() => undefined);
  const sourceAbs = resolve(targetRepoPath);

  // Fresh, unique working copy under the /Users-visible parent (NEVER /tmp).
  const parent = options.workingCopyDir
    ? resolve(options.workingCopyDir)
    : makeUniqueWorkingCopyDir();
  // Create the copy root fresh. mkdtemp is not used for the default path because
  // the name must keep the `.worktree-<token>` shape the gitignore covers; the
  // token already guarantees uniqueness.
  // `recursive: true` creates the default parent (`~/.spec-lantern/worktrees`,
  // or the SPEC_LANTERN_WORKDIR override) on demand along with the per-run copy
  // root, so the workdir never has to pre-exist.
  await rm(parent, { recursive: true, force: true });
  await mkdir(parent, { recursive: true });
  const workingCopyDir = parent;

  log(
    `Copying Target_Repo ${sourceAbs} → throwaway working copy ${workingCopyDir} ` +
      `(excluding ${[...WORKING_COPY_EXCLUDED_DIRS].join("/")})`,
  );
  await cp(sourceAbs, workingCopyDir, {
    recursive: true,
    filter: (source) => {
      // `source` is an absolute path inside the original; exclude it if ANY of
      // its path segments (relative to the source root) is an excluded dir.
      const relToSource = source.slice(sourceAbs.length).replace(/^[/\\]/, "");
      if (relToSource === "") return true;
      const segments = relToSource.split(/[/\\]/);
      return !segments.some((segment) => WORKING_COPY_EXCLUDED_DIRS.has(segment));
    },
  });

  // Optionally stage property test files from the spec root INTO the copy so
  // the caller does not have to place them by hand.
  if (options.specRoot && options.properties && options.properties.length > 0) {
    await stagePropertiesInto(
      workingCopyDir,
      options.specRoot,
      options.properties,
      log,
    );
  }

  return { workingCopyDir };
}

/**
 * Stage each property's `properties/property-{n}.{claimId}.test.ts` from a spec
 * root INTO an EXISTING copy directory, at the same `properties/`-relative path.
 * Factored out so a caller that already owns a copy (the Revive loop, which
 * copies via {@link ../revive/apply-fixes.ts} and then applies fixes) can stage
 * the property files the same way {@link prepareWorkingCopy} does for a fresh
 * copy.
 *
 * @throws if a requested property's id does not follow the
 *   `property-{n}.{claimId}` convention.
 */
export async function stagePropertiesInto(
  copyDir: string,
  specRoot: string,
  properties: readonly WorkingCopyProperty[],
  log: (message: string) => void = () => undefined,
): Promise<void> {
  const specRootAbs = resolve(specRoot);
  const copyAbs = resolve(copyDir);
  for (const property of properties) {
    const parsed = parsePropertyTestFileName(`${property.id}.test.ts`);
    if (!parsed) {
      throw new Error(
        `cannot stage property "${property.id}": its id does not follow the ` +
          `property-{n}.{claimId} convention`,
      );
    }
    const fileName = propertyTestFileName(parsed.propertyNumber, parsed.claimId);
    const src = join(specRootAbs, ARTIFACT_PATHS.propertiesDir, fileName);
    const dest = join(copyAbs, ARTIFACT_PATHS.propertiesDir, fileName);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest);
    log(`Staged property ${property.id} → ${ARTIFACT_PATHS.propertiesDir}/${fileName}`);
  }
}

/**
 * Remove a working copy created by {@link prepareWorkingCopy}. Safe to call on a
 * missing path; never touches anything outside the given copy path. Callers run
 * this in a `finally` so a throwaway copy never leaks between runs.
 */
export async function cleanupWorkingCopy(workingCopyDir: string): Promise<void> {
  await rm(workingCopyDir, { recursive: true, force: true });
}

/**
 * The property-test-file path, RELATIVE to the working copy, at which a staged
 * property lands. Callers pass this as the runner's `propertyTestFile` so the
 * runner runs it IN PLACE from within the single mounted copy (never staging an
 * external host file into the mount). Mirrors {@link prepareWorkingCopy}'s
 * staging path.
 *
 * @throws if `propertyId` does not follow the `property-{n}.{claimId}` convention.
 */
export function stagedPropertyTestFileRel(propertyId: string): string {
  const parsed = parsePropertyTestFileName(`${propertyId}.test.ts`);
  if (!parsed) {
    throw new Error(
      `cannot resolve staged test file for "${propertyId}": its id does not ` +
        `follow the property-{n}.{claimId} convention`,
    );
  }
  const fileName = propertyTestFileName(parsed.propertyNumber, parsed.claimId);
  return `${ARTIFACT_PATHS.propertiesDir}/${fileName}`;
}
