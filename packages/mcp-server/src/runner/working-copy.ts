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
 *
 * WHERE THE PROPERTY FILES LAND, AND WHY (the import-resolution fix). An
 * end-to-end trial of the packaged Power found a second bug on top of the
 * read-only one: property files were staged FLAT at `<copy>/properties/`, but a
 * property imports the target RELATIVE to the property file's OWN location in
 * the spec (for example `../../../src/utils` from
 * `.spec-lantern/src-utils/properties/`). Flattened to `<copy>/properties/`,
 * those relative imports resolve to the wrong place and every property returns
 * EXECUTION_ERROR. The fix keeps the property file at the SAME location, relative
 * to the target, that it had in the spec:
 *
 *  - **spec root INSIDE the Target_Repo** (the common case — the spec is written
 *    under the target, e.g. `<target>/.spec-lantern/...`). The copy of the target
 *    ALREADY contains the whole spec at the same relative path, so nothing is
 *    staged. Each property runs IN PLACE at
 *    `<specRoot-relative-to-target>/properties/property-{n}.{claimId}.test.ts`,
 *    so its relative imports resolve exactly as they did in the repo.
 *  - **spec root OUTSIDE the Target_Repo.** The copy does not contain the spec,
 *    so the WHOLE spec directory is copied into the copy at the fixed path
 *    {@link EXTERNAL_SPEC_MOUNT_REL}. Each property then runs at
 *    `{EXTERNAL_SPEC_MOUNT_REL}/properties/...`. Because the spec now sits at a
 *    DIFFERENT depth than it did on disk, a property that imports the target by a
 *    relative path would not resolve — such a property must import the target via
 *    its `@/...` alias (steering tells authors this). The prepared-copy result
 *    reports where the spec was placed and how imports resolve.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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
 * The fixed, copy-root-relative path the WHOLE spec directory is copied to when
 * the spec root lives OUTSIDE the Target_Repo. A dotfile-scoped name so it never
 * collides with the target's own files, and stable so {@link stagedPropertyTestFileRel}
 * can resolve the in-mount property path from a propertyId without extra state.
 * When the spec root is INSIDE the target this is unused: the spec is already in
 * the copy at its own relative path (see {@link specRootRelInsideTarget}).
 */
export const EXTERNAL_SPEC_MOUNT_REL = ".spec-lantern-spec";

/**
 * Compute the POSIX path of `specRoot` RELATIVE to `targetRepoPath` when the
 * spec root is INSIDE (equal to, or a descendant of) the target repo, or `null`
 * when it is outside. Both paths are resolved to absolutes first so symlink-free
 * `..`/`.` segments and trailing slashes do not fool the containment check.
 *
 * A return of `""` means the spec root IS the target repo root (the spec lives
 * directly at the target's top level); a non-empty value is the subdirectory
 * path (POSIX-separated). `null` means the spec is elsewhere on disk and must be
 * copied into the mount separately.
 */
export function specRootRelInsideTarget(
  targetRepoPath: string,
  specRoot: string,
): string | null {
  const targetAbs = resolve(targetRepoPath);
  const specAbs = resolve(specRoot);
  const rel = relative(targetAbs, specAbs);
  // `relative` yields "" when equal, a plain subpath when inside, and a path
  // starting with ".." (or an absolute path on a different root) when outside.
  if (rel === "") return "";
  if (rel.startsWith("..") || resolve(targetAbs, rel) !== specAbs) return null;
  // Guard against an absolute result (different drive on Windows).
  if (rel.split(sep)[0] === "") return null;
  return rel.split(sep).join("/");
}

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
   * Optional spec root. When provided, the spec's property files are made
   * available inside the copy at the SAME location relative to the target they
   * had in the spec (in place when the spec root is inside the target; the whole
   * spec copied to {@link EXTERNAL_SPEC_MOUNT_REL} when it is outside), so the
   * caller does not place files by hand and relative imports resolve. The
   * returned `specMountRel` is the base to resolve each property's test file
   * under (via {@link stagedPropertyTestFileRel}).
   */
  specRoot?: string;
  /**
   * The properties intended to run. Accepted for API symmetry; `prepareWorkingCopy`
   * makes the WHOLE spec available (in place or copied), so it does not stage
   * files per-property. Id validity is checked when the runner resolves each
   * property's path.
   */
  properties?: readonly WorkingCopyProperty[];
  /** Optional progress sink (defaults to no-op). */
  log?: (message: string) => void;
}

/** The prepared working copy a caller mounts. */
export interface PreparedWorkingCopy {
  /** Absolute path to the fresh working copy (the ONE dir to mount). */
  workingCopyDir: string;
  /**
   * Where the spec directory lives INSIDE the copy, relative to the copy root
   * (POSIX), when a `specRoot` was given — the base the property test files
   * resolve under. It is:
   *  - the spec root's path relative to the target (possibly `""` for a spec at
   *    the target root) when the spec root is INSIDE the target (nothing was
   *    staged; the copy already contains it), or
   *  - {@link EXTERNAL_SPEC_MOUNT_REL} when the spec root was OUTSIDE the target
   *    and the whole spec directory was copied into the mount.
   * `undefined` when no `specRoot` was given (properties are assumed to already
   * live inside the copy and the runner resolves `<id>.test.ts` in place).
   */
  specMountRel?: string;
  /**
   * Human-readable note describing where the property files were placed and how
   * their imports resolve, surfaced in the tool result so the author can see it.
   * `undefined` when no `specRoot` was given.
   */
  importResolutionNote?: string;
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
 * (excluding {@link WORKING_COPY_EXCLUDED_DIRS}) and, when a `specRoot` is given,
 * make that spec's property files available inside the copy at the SAME location
 * relative to the target they had in the spec, so their imports resolve:
 *  - spec root INSIDE the target → nothing is staged (the copied target already
 *    contains it); properties run in place at `<specRel>/properties/...`.
 *  - spec root OUTSIDE the target → the whole spec directory is copied into the
 *    copy at {@link EXTERNAL_SPEC_MOUNT_REL}.
 *
 * The original is only ever READ (`cp` reads from it); it is never opened for
 * writing. Returns the copy path (to mount), the spec's in-copy location
 * (`specMountRel`), and a human-readable import-resolution note; the caller owns
 * teardown via {@link cleanupWorkingCopy} (typically in a `finally`).
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

  // Resolve WHERE the spec (and therefore the property files) lives inside the
  // copy, so each property runs from the SAME location relative to the target it
  // had in the spec and its relative imports resolve. No `specRoot` → the caller
  // placed the files and the runner resolves `<id>.test.ts` in place.
  if (!options.specRoot) {
    return { workingCopyDir };
  }

  const insideRel = specRootRelInsideTarget(sourceAbs, options.specRoot);
  let specMountRel: string;
  let importResolutionNote: string;
  if (insideRel !== null) {
    // Spec root is INSIDE the target: the copy already contains the spec at the
    // same relative path. Stage NOTHING — run each property in place there.
    specMountRel = insideRel;
    const propsRel = joinRel(insideRel, ARTIFACT_PATHS.propertiesDir);
    importResolutionNote =
      `spec root is inside the Target_Repo at "${insideRel || "."}"; ` +
      `the working copy already contains it, so property files run in place at ` +
      `"${propsRel}/property-{n}.{claimId}.test.ts". Their imports resolve ` +
      `relative to that real location inside the target (or via the target's ` +
      `"@/..." alias).`;
    log(
      `Spec root is inside the Target_Repo ("${insideRel || "."}"); ` +
        `running properties in place (no staging)`,
    );
  } else {
    // Spec root is OUTSIDE the target: copy the WHOLE spec directory into the
    // copy at the fixed mount path so the property files (and their sibling
    // artifacts) are visible in the container.
    const specDest = join(workingCopyDir, EXTERNAL_SPEC_MOUNT_REL);
    log(
      `Spec root is outside the Target_Repo; copying the whole spec directory ` +
        `${resolve(options.specRoot)} → ${EXTERNAL_SPEC_MOUNT_REL}/ inside the copy`,
    );
    await cp(resolve(options.specRoot), specDest, { recursive: true });
    specMountRel = EXTERNAL_SPEC_MOUNT_REL;
    const propsRel = `${EXTERNAL_SPEC_MOUNT_REL}/${ARTIFACT_PATHS.propertiesDir}`;
    importResolutionNote =
      `spec root was outside the Target_Repo; the whole spec directory was ` +
      `copied into the working copy at "${EXTERNAL_SPEC_MOUNT_REL}/", so ` +
      `property files run at "${propsRel}/property-{n}.{claimId}.test.ts". ` +
      `Because the spec now sits at a different depth than on disk, properties ` +
      `MUST import the target through its "@/..." alias (a relative path would ` +
      `not resolve).`;
  }

  return { workingCopyDir, specMountRel, importResolutionNote };
}

/** Join a possibly-empty POSIX base with a segment (`""` + `properties` → `properties`). */
function joinRel(base: string, segment: string): string {
  return base ? `${base}/${segment}` : segment;
}

/** What {@link stagePropertiesInto} resolves to: where the spec lives in the copy. */
export interface StagedSpec {
  /**
   * The spec directory's path relative to the copy root (POSIX), the base the
   * property files resolve under. See {@link PreparedWorkingCopy.specMountRel}.
   */
  specMountRel: string;
  /** Human-readable note on placement + import resolution. */
  importResolutionNote: string;
}

/**
 * Make a spec root's property files available INSIDE an EXISTING copy directory
 * at the SAME location, relative to the target, they had in the spec — so a
 * property's relative imports resolve. Factored out so a caller that already
 * owns a copy (the Revive loop, which copies via {@link ../revive/apply-fixes.ts}
 * and then applies fixes) uses the same inside/outside resolution
 * {@link prepareWorkingCopy} does for a fresh copy.
 *
 * `targetRepoPath` is the ORIGINAL target the copy was made from — needed to
 * decide whether the spec root is inside it (already present in the copy, stage
 * nothing) or outside it (copy the whole spec into {@link EXTERNAL_SPEC_MOUNT_REL}).
 *
 * @throws if a requested property's id does not follow the
 *   `property-{n}.{claimId}` convention.
 */
export async function stagePropertiesInto(
  copyDir: string,
  specRoot: string,
  targetRepoPath: string,
  properties: readonly WorkingCopyProperty[],
  log: (message: string) => void = () => undefined,
): Promise<StagedSpec> {
  const specRootAbs = resolve(specRoot);
  const copyAbs = resolve(copyDir);

  // Validate every id up front so a bad id never silently skips staging.
  for (const property of properties) {
    if (!parsePropertyTestFileName(`${property.id}.test.ts`)) {
      throw new Error(
        `cannot stage property "${property.id}": its id does not follow the ` +
          `property-{n}.{claimId} convention`,
      );
    }
  }

  const insideRel = specRootRelInsideTarget(targetRepoPath, specRootAbs);
  if (insideRel !== null) {
    // Inside the target → the copy already contains the spec. Nothing to stage;
    // the property files run in place at their own relative location.
    const propsRel = joinRel(insideRel, ARTIFACT_PATHS.propertiesDir);
    log(
      `Spec root is inside the Target_Repo ("${insideRel || "."}"); ` +
        `property files run in place at "${propsRel}/" (no staging)`,
    );
    return {
      specMountRel: insideRel,
      importResolutionNote:
        `spec root is inside the Target_Repo at "${insideRel || "."}"; ` +
        `property files run in place at "${propsRel}/property-{n}.{claimId}.test.ts" ` +
        `and their imports resolve relative to that real location (or via the ` +
        `target's "@/..." alias).`,
    };
  }

  // Outside the target → copy the whole spec directory into the fixed mount path.
  const specDest = join(copyAbs, EXTERNAL_SPEC_MOUNT_REL);
  await cp(specRootAbs, specDest, { recursive: true });
  log(
    `Spec root is outside the Target_Repo; copied the whole spec directory ` +
      `${specRootAbs} → ${EXTERNAL_SPEC_MOUNT_REL}/ inside the copy`,
  );
  const propsRel = `${EXTERNAL_SPEC_MOUNT_REL}/${ARTIFACT_PATHS.propertiesDir}`;
  return {
    specMountRel: EXTERNAL_SPEC_MOUNT_REL,
    importResolutionNote:
      `spec root was outside the Target_Repo; the whole spec directory was ` +
      `copied into the working copy at "${EXTERNAL_SPEC_MOUNT_REL}/", so property ` +
      `files run at "${propsRel}/property-{n}.{claimId}.test.ts". Properties MUST ` +
      `import the target through its "@/..." alias (a relative path would not resolve).`,
  };
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
 * property lives. Callers pass this as the runner's `propertyTestFile` so the
 * runner runs it IN PLACE from within the single mounted copy (never staging an
 * external host file into the mount).
 *
 * The path is resolved UNDER `specMountRel` — the spec directory's location
 * inside the copy returned by {@link prepareWorkingCopy} / {@link stagePropertiesInto}
 * — so the property runs from the SAME location, relative to the target, it had
 * in the spec. That is the whole import-resolution fix: a property at
 * `<specMountRel>/properties/...` keeps the depth its relative imports assume.
 *
 * @param specMountRel the spec directory's copy-root-relative path (possibly
 *   `""` for a spec at the copy root).
 * @param propertyId the `property-{n}.{claimId}` stem.
 * @throws if `propertyId` does not follow the `property-{n}.{claimId}` convention.
 */
export function stagedPropertyTestFileRel(
  specMountRel: string,
  propertyId: string,
): string {
  const parsed = parsePropertyTestFileName(`${propertyId}.test.ts`);
  if (!parsed) {
    throw new Error(
      `cannot resolve staged test file for "${propertyId}": its id does not ` +
        `follow the property-{n}.{claimId} convention`,
    );
  }
  const fileName = propertyTestFileName(parsed.propertyNumber, parsed.claimId);
  const propsRel = joinRel(specMountRel, ARTIFACT_PATHS.propertiesDir);
  return `${propsRel}/${fileName}`;
}
