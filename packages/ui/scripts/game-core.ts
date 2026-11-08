/**
 * Pure core of the "Trust or Test?" game-data generator — the testable logic
 * that assembles {@link GameData} from the real pipeline artifacts. Mirrors the
 * timeline generator: all I/O goes through injected {@link GameReaders}, so the
 * tests drive it with in-memory fixtures (no filesystem, no git).
 *
 * The thin CLI (generate-game.ts) wires in the real `fs` + the on-disk report
 * modules and writes the result to `public/reports/game.json`.
 *
 * SOURCES (all real, none invented — report-data-fidelity):
 *   - the assembled Lantern_Report for each target (itself verbatim from the
 *     artifacts) supplies each row's `display.claimText` / `sourceLocation` /
 *     `evidence` / `symptomOf` and whether the row is a Confirmed_Bug;
 *   - `locks/<propertyId>.lock.json` supplies Kiro's LOCKED prediction;
 *   - `results/stage-c/<name>.json` supplies the EXECUTED verdict;
 *   - `game/source-excerpts.json` supplies the verbatim code excerpt, whose
 *     `fileSha256` is re-verified against the sandbox source when present.
 *
 * The generator CROSS-CHECKS: a claim is emitted only when the report row, the
 * lock, the stage-c result, and the excerpt all agree (same propertyId, and the
 * report's predicted/actual equal the lock verdict / stage-c verdict). Any
 * mismatch throws, so the asset can never drift from the artifacts.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LanternReport, PropertyComparison } from "@spec-lantern/types";
import type { LanternStory } from "../src/report-asset.js";
import type {
  GameClaim,
  GameCredit,
  GameData,
  GameVerdict,
} from "../src/game-asset.js";

/* -------------------------------------------------------------------------- */
/* Injected-reader seams                                                      */
/* -------------------------------------------------------------------------- */

/** The side-effecting readers the generator depends on, injectable for tests. */
export interface GameReaders {
  /** Read a UTF-8 file by absolute path. */
  readFile(path: string): Promise<string>;
  /**
   * Read the RAW BYTES of a sandbox source file for hash verification, or
   * `null` when the file is absent (sandbox/ is gitignored, so on a clean
   * checkout it may not exist — then verification is skipped, not failed).
   */
  readSourceBytes(repoRelPath: string): Promise<Buffer | null>;
}

/** One target to build claims for. */
export interface GameTargetSource {
  readonly id: string;
  readonly label: string;
  /** Absolute path to the target's skeleton directory. */
  readonly rootAbs: string;
  /** Absolute path to the repo root (to resolve sandbox source paths). */
  readonly repoRootAbs: string;
  /** The assembled Lantern_Report for this target. */
  readonly report: LanternReport;
  /** The report story (for the credit line). */
  readonly story: LanternStory;
}

/* -------------------------------------------------------------------------- */
/* Excerpt file shape                                                         */
/* -------------------------------------------------------------------------- */

interface ExcerptSegment {
  readonly startLine: number;
  readonly endLine: number;
  readonly code: string;
}

interface SourceExcerpt {
  readonly propertyId: string;
  readonly sourceFile: string;
  readonly claimLine: number;
  readonly claimText: string;
  readonly segments: readonly ExcerptSegment[];
  readonly fileSha256: string;
}

interface ExcerptFile {
  readonly excerpts: readonly SourceExcerpt[];
}

/* -------------------------------------------------------------------------- */
/* claims.json shape                                                          */
/* -------------------------------------------------------------------------- */

interface ClaimRecord {
  readonly id: string;
  readonly description: string;
  readonly commentRef?: string;
}

interface ClaimsFile {
  readonly claims: readonly ClaimRecord[];
}

/** The claim id is the propertyId suffix after the first dot. */
function claimIdOf(propertyId: string): string {
  const dot = propertyId.indexOf(".");
  return dot === -1 ? propertyId : propertyId.slice(dot + 1);
}

/**
 * Parse the set of source line numbers a claim's `commentRef` references.
 * Handles both single tokens (`L17`) and ranges (`L42-46`, meaning 42..46).
 * Used to assert the excerpt's highlighted claim line actually belongs to the
 * claim — the "same claim" consistency check.
 */
function commentRefLines(commentRef: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!commentRef) return lines;
  const re = /L(\d+)(?:-(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(commentRef)) !== null) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    for (let n = start; n <= end; n++) lines.add(n);
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Small parse helpers (verbatim reads, never fabrication)                    */
/* -------------------------------------------------------------------------- */

/** Parse the predicted verdict out of a lock file's JSON. */
function parseLockVerdict(json: string): GameVerdict {
  const obj = JSON.parse(json) as { verdict?: unknown };
  if (obj.verdict !== "PASS" && obj.verdict !== "FAIL") {
    throw new Error(`lock verdict is not PASS/FAIL: ${String(obj.verdict)}`);
  }
  return obj.verdict;
}

/** Parse the executed verdict out of a stage-c result file's JSON. */
function parseStageCVerdict(json: string): GameVerdict {
  const obj = JSON.parse(json) as {
    actualResult?: { outcome?: unknown; verdict?: unknown };
  };
  const actual = obj.actualResult;
  if (!actual || actual.outcome !== "VERDICT") {
    throw new Error("stage-c result has no VERDICT outcome");
  }
  if (actual.verdict !== "PASS" && actual.verdict !== "FAIL") {
    throw new Error(
      `stage-c verdict is not PASS/FAIL: ${String(actual.verdict)}`,
    );
  }
  return actual.verdict;
}

/**
 * The file name under `results/stage-c/` for a property is `<propertyId>.json`
 * (both targets name the per-property result files that way).
 */
function stageCFileName(propertyId: string): string {
  return `${propertyId}.json`;
}

/** Parse the trailing `:<line>` off a `file:line` source location, or null. */
function lineOf(sourceLocation: string): number | null {
  const m = /:(\d+)\s*$/.exec(sourceLocation);
  return m ? Number(m[1]) : null;
}

/**
 * The resolved comment a game round should DISPLAY: text, a `file:line`
 * location, and the absolute source line, all CONSISTENT with the excerpt the
 * round shows (the displayed line is always inside the excerpt).
 *
 * Why this is needed: for the MoodPlays lie, the REPORT row headlines the
 * `// Handle 24-hour format` comment at `openingHoursParser.ts:17` — a line
 * OUTSIDE the excerpt (L48-61) the game shows, which would read as inconsistent.
 * The headline STORY instead quotes the root-cause comment `// Check for 24
 * hours` at `:51`, which IS inside the excerpt. So when the report's claim line
 * is outside the excerpt and the story is about this property, we fall back to
 * the story's comment (keeping the game consistent with the report story). The
 * excerpt's own `claimLine`/`claimText` (extracted to the story's line) is the
 * final authority; a resolved line outside the excerpt range throws.
 */
interface ResolvedClaim {
  readonly claimText: string;
  readonly sourceLocation: string;
  readonly claimLine: number;
}

/**
 * Resolve the comment a round DISPLAYS and verify it belongs to the SAME claim
 * as the description and the excerpt. The excerpt's `claimLine` is the
 * authority: it must fall inside one of the excerpt's segments (so the round
 * shows the line it highlights) AND be referenced by the claim's own
 * `commentRef` in claims.json (so the highlighted comment really is this
 * claim's comment). The displayed text is the report row's `display.claimText`
 * when that row is anchored on the claim line, else the excerpt's own verbatim
 * claim line (trimmed) — either way it is the comment at `claimLine`.
 */
function resolveClaim(
  excerpt: SourceExcerpt,
  display: { claimText: string; sourceLocation: string },
  claimRef: { id: string; commentRefLines: Set<number> },
): ResolvedClaim {
  const claimLine = excerpt.claimLine;

  // (a) The claim line must be inside one of the shown segments.
  const inSegment = excerpt.segments.some(
    (s) => claimLine >= s.startLine && claimLine <= s.endLine,
  );
  if (!inSegment) {
    throw new Error(
      `claim line ${claimLine} for ${excerpt.propertyId} is not inside any excerpt segment`,
    );
  }

  // (b) Same-claim check: the highlighted line must be one the claim's own
  //     commentRef points at. This ties comment + description + excerpt to one
  //     claim id and fails the build if they drift apart.
  if (
    claimRef.commentRefLines.size > 0 &&
    !claimRef.commentRefLines.has(claimLine)
  ) {
    throw new Error(
      `claim line ${claimLine} for ${excerpt.propertyId} is not referenced by ` +
        `claim ${claimRef.id}'s commentRef (lines ` +
        `${[...claimRef.commentRefLines].sort((x, y) => x - y).join(", ")})`,
    );
  }

  // Display text: prefer the report row's comment when it is anchored on the
  // claim line; else the excerpt's verbatim claim line (trimmed). Both are the
  // comment AT claimLine, so the quoted comment always matches the highlight.
  const basename = excerpt.sourceFile.split("/").pop() ?? excerpt.sourceFile;
  if (lineOf(display.sourceLocation) === claimLine) {
    return {
      claimText: display.claimText,
      sourceLocation: display.sourceLocation,
      claimLine,
    };
  }
  return {
    claimText: excerpt.claimText.trim(),
    sourceLocation: `${basename}:${claimLine}`,
    claimLine,
  };
}

/** Do two excerpts overlap in the same file (any segment vs any segment)? */
function excerptsOverlap(
  a: GameClaim,
  b: GameClaim,
): boolean {
  if (a.sourceFile !== b.sourceFile) return false;
  return a.segments.some((sa) =>
    b.segments.some(
      (sb) => sa.startLine <= sb.endLine && sb.startLine <= sa.endLine,
    ),
  );
}

/**
 * Patterns that pull an Expected-vs-Actual pair out of a fast-check
 * `observedOutput` STRING. Kept in sync with the UI's
 * STRING_CONTRAST_PATTERNS (components.tsx) so both read the same real message
 * the same way. Group 1 = expected, group 2 = actual.
 */
const STRING_CONTRAST_PATTERNS: readonly RegExp[] = [
  /expected[^:]*\bfirst row:\s*(.+?),\s*actual[^:]*\bfirst row:\s*(.+?)(?::|$)/i,
  /expected\s+'?(.+?)'?\s+to be\s+'?(.+?)'?(?:\s*\/\/|$)/i,
];

/**
 * Build the plain-words counterexample for a FAIL claim, from the persisted
 * data only — never an invented contrast. In order of preference:
 *   1. the report row's AUTHORED Expected/Actual evidence (verbatim from the
 *      counterexample), e.g. MoodPlays;
 *   2. an Expected/Actual pair PARSED out of the fast-check `observedOutput`
 *      string (the writing-tracker "expected first row: …, actual first row: …"
 *      message), using the same patterns the UI uses;
 *   3. the raw counterexample input as a last resort.
 */
function plainCounterexample(
  comparison: PropertyComparison,
): string | undefined {
  const evidence = comparison.display?.evidence;
  if (evidence) {
    return `Expected ${evidence.expected}; execution produced ${evidence.actual}.`;
  }
  const actual = comparison.actual;
  if (actual.outcome !== "VERDICT" || !actual.counterexample) return undefined;

  const output = actual.counterexample.observedOutput;
  if (typeof output === "string") {
    for (const pattern of STRING_CONTRAST_PATTERNS) {
      const m = pattern.exec(output);
      if (m) {
        return `Expected ${m[1].trim()}; execution produced ${m[2].trim()}.`;
      }
    }
  }

  const input =
    typeof actual.counterexample.input === "string"
      ? actual.counterexample.input
      : JSON.stringify(actual.counterexample.input);
  return `A counterexample input that execution rejected: ${input}`;
}

/**
 * The root-cause note for a symptom row, derived from its `display.symptomOf`
 * (plus the row's own note when present). Only a FAIL row flagged `symptomOf`
 * gets one. Keeps the symptom from being presented as a separate lie.
 */
function rootCauseNote(comparison: PropertyComparison): string | undefined {
  const symptomOf = comparison.display?.symptomOf;
  if (!symptomOf) return undefined;
  const note = comparison.display?.note;
  const base = `Not a lie on its own — this comment holds. It only failed as a symptom of the ${symptomOf}.`;
  return note ? `${base} ${note}` : base;
}

/**
 * The "How to spot it" text shown after the reveal, from VERIFIED sources only
 * (no hand-written explanation):
 *   - LIE: the report story's user-impact wording for this claim — the SAME
 *     sentence the report page shows — but only when the story is actually
 *     about this property. (The counterexample is shown separately by the UI.)
 *     If the story is not about this claim, there is no verified lie text, so
 *     we return undefined and the UI shows nothing.
 *   - HELD (PASS): a factual statement of what a passing property run means,
 *     with the real generated-input count IF the persisted result records one.
 *     No PASS result in this repo records a count, so the number is omitted (as
 *     the spec requires) rather than invented.
 */
function howToSpot(
  comparison: PropertyComparison,
  story: LanternStory,
  verdict: GameVerdict,
  runCount: number | null,
): string | undefined {
  if (verdict === "FAIL") {
    if (story.propertyId === comparison.propertyId) {
      return story.execution.userImpact;
    }
    return undefined;
  }
  // HELD: factual line from the persisted PASS result.
  if (runCount !== null) {
    return `Execution ran ${runCount} generated inputs and every one matched the comment, so the claim held.`;
  }
  return "Execution ran generated inputs and every one matched the comment, so the claim held.";
}

/**
 * Parse a recorded generated-input count from a stage-c result, or null. Some
 * runs record a `numRuns` / `numTests`; most PASS results do not, in which case
 * the game omits the number (never fabricates one).
 */
function parseRunCount(json: string): number | null {
  const obj = JSON.parse(json) as {
    actualResult?: { numRuns?: unknown; numTests?: unknown };
  };
  const a = obj.actualResult;
  const n = a?.numRuns ?? a?.numTests;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------------------- */
/* Per-target claims                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the {@link GameClaim}s for one target by joining its report rows with
 * the lock verdicts, the stage-c verdicts, and the committed excerpts, verifying
 * agreement at every join. A row with no matching excerpt is skipped (it is not
 * part of the game); a row that is not an executed VERDICT is skipped. Any
 * ACTUAL disagreement (lock vs report predicted, stage-c vs report actual,
 * excerpt hash vs sandbox source) throws.
 */
export async function buildTargetClaims(
  readers: GameReaders,
  target: GameTargetSource,
): Promise<readonly GameClaim[]> {
  // 1. Load + index the committed excerpts.
  const excerptsAbs = join(target.rootAbs, "game", "source-excerpts.json");
  const excerptFile = JSON.parse(
    await readers.readFile(excerptsAbs),
  ) as ExcerptFile;
  const excerptByProp = new Map(
    excerptFile.excerpts.map((e) => [e.propertyId, e]),
  );

  // 1b. Load + index claims.json (claim descriptions + commentRef).
  const claimsAbs = join(target.rootAbs, "claims.json");
  const claimsFile = JSON.parse(
    await readers.readFile(claimsAbs),
  ) as ClaimsFile;
  const claimById = new Map(claimsFile.claims.map((c) => [c.id, c]));

  // Cache a sandbox file's computed hash so a file used by several excerpts is
  // read + hashed once.
  const hashCache = new Map<string, string | null>();
  async function sandboxHash(rel: string): Promise<string | null> {
    if (hashCache.has(rel)) return hashCache.get(rel) ?? null;
    const bytes = await readers.readSourceBytes(rel);
    const hash = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
    hashCache.set(rel, hash);
    return hash;
  }

  const claims: GameClaim[] = [];
  for (const comparison of target.report.comparisons) {
    const { propertyId, actual, predicted, display } = comparison;

    // Only EXECUTED PASS/FAIL rows are playable.
    if (actual.outcome !== "VERDICT") continue;
    const reportVerdict = actual.verdict;

    // Must have a committed excerpt to be shown.
    const excerpt = excerptByProp.get(propertyId);
    if (!excerpt) continue;

    // The claim id joins the comment, the description and the excerpt. The
    // claims.json record supplies the VERBATIM description and the commentRef
    // used for the same-claim consistency check.
    const claimId = claimIdOf(propertyId);
    const claimRecord = claimById.get(claimId);
    if (!claimRecord) {
      throw new Error(
        `no claims.json entry for ${claimId} (property ${propertyId})`,
      );
    }
    if (excerpt.propertyId !== propertyId) {
      throw new Error(
        `excerpt propertyId ${excerpt.propertyId} != report propertyId ${propertyId}`,
      );
    }

    // The comment text + source are RESOLVED to the excerpt's claim line, and
    // the resolver asserts that line is inside a segment AND referenced by this
    // claim's commentRef — so comment, description and excerpt share one claim.
    const reportClaimText = display?.claimText;
    const reportSourceLocation = display?.sourceLocation;
    if (!reportClaimText || !reportSourceLocation) continue;
    const resolved = resolveClaim(
      excerpt,
      { claimText: reportClaimText, sourceLocation: reportSourceLocation },
      { id: claimId, commentRefLines: commentRefLines(claimRecord.commentRef) },
    );

    // 2. Cross-check the LOCKED prediction against the report's predicted.
    const lockAbs = join(target.rootAbs, "locks", `${propertyId}.lock.json`);
    const lockVerdict = parseLockVerdict(await readers.readFile(lockAbs));
    if (predicted !== null && predicted !== lockVerdict) {
      throw new Error(
        `prediction mismatch for ${propertyId}: report ${predicted} vs lock ${lockVerdict}`,
      );
    }

    // 3. Cross-check the EXECUTED verdict against the report's actual.
    const stageCAbs = join(
      target.rootAbs,
      "results",
      "stage-c",
      stageCFileName(propertyId),
    );
    const stageCVerdict = parseStageCVerdict(await readers.readFile(stageCAbs));
    if (stageCVerdict !== reportVerdict) {
      throw new Error(
        `verdict mismatch for ${propertyId}: report ${reportVerdict} vs stage-c ${stageCVerdict}`,
      );
    }

    // 4. Re-verify the excerpt hash against the sandbox source when present.
    const actualHash = await sandboxHash(excerpt.sourceFile);
    if (actualHash !== null && actualHash !== excerpt.fileSha256) {
      throw new Error(
        `source hash drift for ${excerpt.sourceFile}: excerpt ${excerpt.fileSha256} vs sandbox ${actualHash}`,
      );
    }

    // 5. The recorded generated-input count (if any) for the "How to spot it"
    //    held-claim line — omitted when the result records none.
    const runCount = parseRunCount(await readers.readFile(stageCAbs));

    // isLie: a Confirmed_Bug whose OWN comment is the lie (not a symptom). This
    // is exactly the countLies definition applied per-row.
    const isLie = comparison.confirmedBug === true && !display?.symptomOf;

    const spot = howToSpot(comparison, target.story, stageCVerdict, runCount);
    const counterexamplePlain =
      stageCVerdict === "FAIL" ? plainCounterexample(comparison) : undefined;
    const note = rootCauseNote(comparison);

    claims.push({
      propertyId,
      claimId,
      targetId: target.id,
      targetLabel: target.label,
      claimText: resolved.claimText,
      description: claimRecord.description,
      sourceLocation: resolved.sourceLocation,
      segments: excerpt.segments.map((s) => ({
        startLine: s.startLine,
        endLine: s.endLine,
        code: s.code,
      })),
      sourceFile: excerpt.sourceFile,
      claimLine: resolved.claimLine,
      verdict: stageCVerdict,
      kiroPrediction: lockVerdict,
      isLie,
      ...(spot !== undefined ? { howToSpot: spot } : {}),
      ...(note !== undefined ? { rootCauseNote: note } : {}),
      ...(counterexamplePlain !== undefined ? { counterexamplePlain } : {}),
    });
  }

  return claims;
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the full {@link GameData} from the injected readers and target
 * sources. Verifies that exactly TWO claims across all targets are `isLie`
 * (both real lies must be present) and that there are at least FOUR PASS claims
 * to fill a 6-round game — throwing if the pool cannot support a game, so the
 * asset is never silently short.
 */
export async function buildGameData(
  readers: GameReaders,
  targets: readonly GameTargetSource[],
  now: () => Date = () => new Date(),
): Promise<GameData> {
  const allClaims: GameClaim[] = [];
  const credits: GameCredit[] = [];
  for (const target of targets) {
    allClaims.push(...(await buildTargetClaims(readers, target)));
    if (target.story.credit) {
      credits.push({ targetId: target.id, credit: target.story.credit });
    }
  }

  const lies = allClaims.filter((c) => c.isLie);
  if (lies.length !== 2) {
    throw new Error(
      `expected exactly 2 lie claims across targets, found ${lies.length}`,
    );
  }

  // FAIRNESS CHECK: a held (PASS) round must not SHOW the buggy line a lie's
  // excerpt reveals. Exclude any held claim whose excerpt overlaps a lie's
  // excerpt in the SAME source file (e.g. MoodPlays property-4
  // "// Open 24 hours, never closing" at :53 lives in the same L48-61 span as
  // the property-1 lie's buggy `includes('24')` line). Lie rounds themselves
  // are kept; only held rounds are filtered.
  const liesBySource = new Map<string, GameClaim[]>();
  for (const lie of lies) {
    const list = liesBySource.get(lie.sourceFile) ?? [];
    list.push(lie);
    liesBySource.set(lie.sourceFile, list);
  }
  const claims = allClaims.filter((c) => {
    if (c.isLie) return true;
    if (c.verdict !== "PASS") return true; // symptoms etc. are not held rounds
    const overlappingLie = (liesBySource.get(c.sourceFile) ?? []).some((lie) =>
      excerptsOverlap(c, lie),
    );
    return !overlappingLie;
  });

  const passes = claims.filter((c) => c.verdict === "PASS" && !c.isLie);
  if (passes.length < 4) {
    throw new Error(
      `need at least 4 non-overlapping PASS claims to fill a game, found ${passes.length}`,
    );
  }

  return {
    generatedAt: now().toISOString(),
    claims,
    credits,
  };
}
