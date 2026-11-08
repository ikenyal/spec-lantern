/**
 * @spec-lantern/mcp-server — derive CorrectnessProperty objects from a spec root
 * on disk (change 1 core).
 *
 * In the end-to-end trial, a Kiro client with NO access to this repo had to
 * guess the shape of the `properties` argument to `execute_properties` /
 * `replay_counterexample` / `apply_fixes_and_reexecute`, and hand-wrote them.
 * But every property is already fully described ON DISK under the spec root:
 * `claims.json` names each Claim, and each `properties/property-{n}.{claimId}.
 * test.ts` carries the exact tag `Feature: spec-lantern, Property {n}: {text}`.
 * This module RECONSTRUCTS the `CorrectnessProperty` objects from those files so
 * the caller can simply OMIT `properties` when a `specRoot` is given.
 *
 * WHY `kind: "function"` IS THE ONLY HONEST RECONSTRUCTION. The on-disk layout
 * does NOT persist `kind`, `title`, `validatesRequirements`, or
 * `embeddedComponentLogic` (see `claims.json` — it only has
 * `id/description/sourceFile/commentRef` — and the property file, which carries
 * only the `Feature: spec-lantern, Property {n}: {text}` tag). The production
 * `executeProperties` path resolves a property's test file FROM ITS ID
 * (`orchestrator/index.ts` → `<id>.test.ts` / `stagedPropertyTestFileRel`), and
 * never consults `kind`/`embeddedComponentLogic`: `planComponentRender` /
 * `stageComponentRenderHarness` are wired only in the walking skeleton
 * (`execute-path.ts`), not the orchestrator — an authored `component_rendered`
 * test file renders the component itself. So the HONEST reconstruction sets
 * `kind: "function"` (no fabricated component metadata), `embeddedComponentLogic`
 * omitted, `validatesRequirements: []` (not persisted), `title` = the Claim's
 * `description` when known else the tag text, `statement` = the tag text, `id` =
 * the file stem, `claimId` from the filename. This is sufficient for execution
 * and the Safety Gate accepts it (no `componentPath` → `classifyProperty`
 * returns null). Inventing `kind`/metadata would violate report-data-fidelity.
 *
 * NO THROW on expected-but-invalid input. A missing `properties/` dir, a
 * missing/invalid `claims.json`, or a property file with no parseable tag all
 * surface as a STRUCTURED {@link DeriveIssue} (mirroring the discipline in
 * `prediction-lock/index.ts`), so the MCP handlers can turn it into a message.
 * Only genuinely unexpected host errors propagate.
 *
 * HOST SAFETY. This only reads TEXT (`claims.json` and each property file's
 * source); it NEVER imports or executes a property test file.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ARTIFACT_PATHS,
  claimsFilePath,
  parsePropertyTag,
  parsePropertyTestFileName,
  type Claim,
  type CorrectnessProperty,
} from "@spec-lantern/types";

/* -------------------------------------------------------------------------- */
/* Structured outcomes (no throw on expected-invalid input)                   */
/* -------------------------------------------------------------------------- */

/** Closed enumeration of why derivation can fail for expected reasons. */
export type DeriveCode =
  /** `<specRoot>/properties/` is missing or unreadable. */
  | "PROPERTIES_DIR_MISSING"
  /** No `property-{n}.{claimId}.test.ts` files were found. */
  | "NO_PROPERTY_FILES"
  /** `<specRoot>/claims.json` is missing. */
  | "CLAIMS_MISSING"
  /** `claims.json` exists but is not parseable / well-formed. */
  | "CLAIMS_INVALID"
  /** A property file is missing its `Feature: spec-lantern, Property {n}:` tag. */
  | "PROPERTY_TAG_MISSING"
  /** The requested propertyId (replay) was not found under `properties/`. */
  | "PROPERTY_NOT_FOUND"
  /**
   * A property file that `readdir` listed could not be read (it vanished
   * between the listing and the read — a concurrent write). Surfaced rather
   * than silently dropped so derivation never under-reports its property count.
   */
  | "PROPERTY_FILE_UNREADABLE";

/** A single structured derivation finding. */
export interface DeriveIssue {
  code: DeriveCode;
  /** Human-readable, self-contained explanation. */
  message: string;
  /** The artifact path this issue concerns, when applicable. */
  path?: string;
}

/** Outcome of {@link deriveProperties}: exactly one of `properties`/`issue`. */
export interface DeriveResult {
  properties: CorrectnessProperty[] | null;
  issue: DeriveIssue | null;
}

/** Outcome of {@link deriveProperty}: exactly one of `property`/`issue`. */
export interface DeriveOneResult {
  property: CorrectnessProperty | null;
  issue: DeriveIssue | null;
}

/* -------------------------------------------------------------------------- */
/* Loading helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Read a UTF-8 text file, returning `null` on ENOENT; other errors propagate. */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Load the `claimId → description` map from `<specRoot>/claims.json`. Returns a
 * structured issue when the file is missing or malformed. An absent file is a
 * hard error (a derived property's `title` falls back to the tag text only when
 * a specific claim entry is absent, not when the whole file is missing).
 */
async function loadClaimDescriptions(
  specRoot: string,
): Promise<{ map: Map<string, string> | null; issue: DeriveIssue | null }> {
  const path = claimsFilePath(specRoot);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return {
      map: null,
      issue: {
        code: "CLAIMS_MISSING",
        message: `Claims file not found at ${path}.`,
        path,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      map: null,
      issue: {
        code: "CLAIMS_INVALID",
        message: `Claims file at ${path} is not valid JSON.`,
        path,
      },
    };
  }

  const claims = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) {
    return {
      map: null,
      issue: {
        code: "CLAIMS_INVALID",
        message: `Claims file at ${path} must be an object with a "claims" array.`,
        path,
      },
    };
  }

  const map = new Map<string, string>();
  for (const entry of claims as Partial<Claim>[]) {
    if (
      entry &&
      typeof entry.id === "string" &&
      typeof entry.description === "string"
    ) {
      map.set(entry.id, entry.description);
    }
  }
  return { map, issue: null };
}

/** Enumerate the property-test basenames under `<specRoot>/properties/`. */
async function listPropertyFiles(
  specRoot: string,
): Promise<{ files: string[] | null; issue: DeriveIssue | null }> {
  const dir = resolve(specRoot, ARTIFACT_PATHS.propertiesDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        files: null,
        issue: {
          code: "PROPERTIES_DIR_MISSING",
          message: `Properties directory not found at ${dir}.`,
          path: dir,
        },
      };
    }
    throw error;
  }
  const files = entries
    .filter((name) => parsePropertyTestFileName(name) !== null)
    .sort((a, b) => {
      const an = parsePropertyTestFileName(a)!.propertyNumber;
      const bn = parsePropertyTestFileName(b)!.propertyNumber;
      return an - bn;
    });
  return { files, issue: null };
}

/**
 * Reconstruct ONE {@link CorrectnessProperty} from a property file's basename
 * and source + the claim descriptions. Returns a structured issue when the tag
 * is missing (`PROPERTY_TAG_MISSING`).
 */
function reconstructProperty(
  fileName: string,
  source: string,
  claimDescriptions: Map<string, string>,
  filePath: string,
): { property: CorrectnessProperty | null; issue: DeriveIssue | null } {
  const parsedName = parsePropertyTestFileName(fileName)!; // caller pre-filtered
  const tag = parsePropertyTag(source);
  if (tag === null) {
    return {
      property: null,
      issue: {
        code: "PROPERTY_TAG_MISSING",
        message:
          `Property file ${filePath} is missing its ` +
          `"Feature: spec-lantern, Property {n}: {text}" tag; cannot derive the ` +
          `CorrectnessProperty from it.`,
        path: filePath,
      },
    };
  }

  const claimId = parsedName.claimId;
  const id = `property-${parsedName.propertyNumber}.${claimId}`;
  const statement = tag.propertyText;
  // title = the Claim's description when known; else the tag text (honest
  // fallback — never invented metadata).
  const title = claimDescriptions.get(claimId) ?? statement;

  const property: CorrectnessProperty = {
    id,
    claimId,
    title,
    statement,
    kind: "function",
    validatesRequirements: [],
  };
  return { property, issue: null };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Derive ALL {@link CorrectnessProperty} objects under a spec root, sorted by
 * property number. Reads `claims.json` and every
 * `properties/property-{n}.{claimId}.test.ts`, extracting each file's tag.
 *
 * Returns a structured {@link DeriveIssue} (never throws) when the properties
 * directory is missing, no property files exist, `claims.json` is missing or
 * invalid, or any property file lacks its tag.
 */
export async function deriveProperties(specRoot: string): Promise<DeriveResult> {
  const listed = await listPropertyFiles(specRoot);
  if (listed.files === null) return { properties: null, issue: listed.issue };
  if (listed.files.length === 0) {
    return {
      properties: null,
      issue: {
        code: "NO_PROPERTY_FILES",
        message:
          `No property-{n}.{claimId}.test.ts files found under ` +
          `${resolve(specRoot, ARTIFACT_PATHS.propertiesDir)}.`,
        path: resolve(specRoot, ARTIFACT_PATHS.propertiesDir),
      },
    };
  }

  const claims = await loadClaimDescriptions(specRoot);
  if (claims.map === null) return { properties: null, issue: claims.issue };

  const properties: CorrectnessProperty[] = [];
  for (const fileName of listed.files) {
    const filePath = resolve(specRoot, ARTIFACT_PATHS.propertiesDir, fileName);
    const source = await readTextOrNull(filePath);
    if (source === null) {
      // `readdir` listed this file but it could not be read (a concurrent write
      // removed it between the listing and the read). Surface the discrepancy
      // as a structured issue instead of silently dropping it — a silent
      // `continue` would under-derive without any signal that a listed property
      // never made it into the result.
      return {
        properties: null,
        issue: {
          code: "PROPERTY_FILE_UNREADABLE",
          message:
            `Property file ${filePath} was listed by the properties directory ` +
            `but could not be read (it may have been removed or written ` +
            `concurrently); refusing to derive fewer properties than were ` +
            `listed without signalling the discrepancy.`,
          path: filePath,
        },
      };
    }
    const built = reconstructProperty(fileName, source, claims.map, filePath);
    if (built.property === null) return { properties: null, issue: built.issue };
    properties.push(built.property);
  }

  return { properties, issue: null };
}

/**
 * Derive the single {@link CorrectnessProperty} whose `id` matches
 * `propertyId` (for `replay_counterexample`). Returns `PROPERTY_NOT_FOUND` when
 * no property file has that id, or forwards any derivation issue.
 */
export async function deriveProperty(
  specRoot: string,
  propertyId: string,
): Promise<DeriveOneResult> {
  const all = await deriveProperties(specRoot);
  if (all.properties === null) return { property: null, issue: all.issue };
  const match = all.properties.find((p) => p.id === propertyId);
  if (!match) {
    return {
      property: null,
      issue: {
        code: "PROPERTY_NOT_FOUND",
        message:
          `No property with id "${propertyId}" was found under ` +
          `${resolve(specRoot, ARTIFACT_PATHS.propertiesDir)}.`,
      },
    };
  }
  return { property: match, issue: null };
}
