/**
 * Static contract for the "Trust or Test?" mini-game data asset.
 *
 * The game is part of the STATIC Hosted_Demo: it ships no runner and executes
 * no Target_Repo code. The game data is GENERATED at build time
 * (scripts/game-core.ts, invoked by scripts/generate-game.ts) from the real
 * pipeline artifacts only — `claims.json`, `locks/`, the persisted
 * `results/stage-c/`, and the committed `game/source-excerpts.json` — and
 * written to `public/reports/game.json`. The game UI FETCHES that JSON at
 * runtime; nothing here is hand-authored.
 *
 * DATA FIDELITY (.kiro/steering/report-data-fidelity.md): every field of every
 * {@link GameClaim} is traceable to one of those artifacts —
 *   - `claimText` + `sourceLocation` + code `segments` + `claimLine`: the
 *     committed `source-excerpts.json`, whose `fileSha256` the generator
 *     re-verifies against the sandbox source; the claim line always lives
 *     inside a segment.
 *   - `description`: the claim's `description` from `claims.json`, VERBATIM —
 *     never paraphrased or hand-written.
 *   - `verdict` (PASS/FAIL): the persisted `results/stage-c/*.json`
 *     `actualResult.verdict`.
 *   - `kiroPrediction`: the LOCKED prediction verdict (`locks/*.lock.json`), the
 *     value Kiro committed to BEFORE any execution.
 *   - `howToSpot`: VERIFIED text only — for a lie, the same report story /
 *     evidence wording the report page shows; for a held claim, a factual line
 *     derived from the persisted PASS result. Omitted when no verified text
 *     exists.
 *   - `counterexamplePlain`: a plain-words rendering built only from the
 *     persisted counterexample (input + the report's authored evidence), never
 *     invented.
 * The generator CHECKS that the comment, description and excerpt all belong to
 * the SAME claim (same claim id, the comment line inside the excerpt) and fails
 * the build otherwise. A claim that cannot be fully sourced is OMITTED.
 */

/** The verdict the lantern reveals — what execution actually proved. */
export type GameVerdict = "PASS" | "FAIL";

/** One contiguous verbatim code segment of a claim's excerpt. */
export interface GameCodeSegment {
  /** 1-based first line of this segment within the source file. */
  readonly startLine: number;
  /** 1-based last line of this segment within the source file. */
  readonly endLine: number;
  /** The verbatim code of this segment (lines joined by "\n"). */
  readonly code: string;
}

/**
 * One playable claim: a real comment, its description, the verbatim code it
 * describes, what execution proved, and what Kiro predicted. The player decides
 * "Trust" (the comment is true, i.e. the player bets PASS) or "Doubt" (it lies,
 * i.e. FAIL) BEFORE the verdict is shown.
 */
export interface GameClaim {
  /** The spec-lantern propertyId this claim came from (stable key). */
  readonly propertyId: string;
  /**
   * The claim id (the propertyId suffix after the first dot, e.g.
   * "claim-24h-to-minutes"), used to join the comment/description/excerpt and
   * to assert they all belong to the SAME claim.
   */
  readonly claimId: string;
  /** Which target the claim belongs to (for crediting + grouping). */
  readonly targetId: string;
  /** Human target label, e.g. "writing-tracker". */
  readonly targetLabel: string;
  /** The comment under test, VERBATIM (trimmed display form). */
  readonly claimText: string;
  /**
   * The claim's description from claims.json, VERBATIM — one plain sentence
   * shown under the comment as "The comment claims: …". Never paraphrased.
   */
  readonly description: string;
  /** Where the comment lives, e.g. "PeriodProgressSummary.tsx:54". */
  readonly sourceLocation: string;
  /**
   * The verbatim code excerpt the comment describes, as one or more segments in
   * display order. Multiple segments (shown with a visible line gap) let a
   * claim show both its comment and the far-away failing lines of the SAME
   * claim.
   */
  readonly segments: readonly GameCodeSegment[];
  /** Sandbox-relative path of the source file the excerpt came from. */
  readonly sourceFile: string;
  /**
   * 1-based absolute source line of the claim comment, so the UI can highlight
   * the exact line inside the segment that contains it. Always inside a segment.
   */
  readonly claimLine: number;
  /** What EXECUTION proved: PASS (comment true) or FAIL (comment lies). */
  readonly verdict: GameVerdict;
  /**
   * Kiro's LOCKED prediction (recorded before execution). PASS means Kiro
   * "trusted" the comment. Used to compute Kiro's score on the final screen.
   */
  readonly kiroPrediction: GameVerdict;
  /**
   * True when this claim is a real LIE: a Confirmed_Bug whose OWN comment is
   * the lie (a FAIL that is not merely a symptom of another row's root cause).
   * Exactly the rows {@link countLies} counts. The two `isLie` claims
   * (writing-tracker monthly order, MoodPlays 24-hour detection) always appear
   * in a game; the held claims fill the rest.
   */
  readonly isLie: boolean;
  /**
   * "How to spot it" text shown AFTER the reveal, from VERIFIED sources only:
   * for a lie, the report story / evidence wording the report page uses; for a
   * held claim, a factual line derived from the persisted PASS result. Omitted
   * (undefined) when no verified text exists — the UI then shows nothing.
   */
  readonly howToSpot?: string;
  /**
   * For a FAIL claim that is a SYMPTOM of another claim's root-cause lie
   * (MoodPlays property-6), the plain-words root-cause note to show — so the
   * symptom is never presented as a separate lie. Omitted otherwise.
   */
  readonly rootCauseNote?: string;
  /**
   * For a FAIL claim, the counterexample stated in plain words (built from the
   * persisted counterexample input + the report's authored Expected/Actual
   * evidence). Omitted for a PASS claim.
   */
  readonly counterexamplePlain?: string;
}

/** Attribution for a target repo shown on the game screen. */
export interface GameCredit {
  /** Target id (matches {@link GameClaim.targetId}). */
  readonly targetId: string;
  /** The credit line, verbatim from the report story (e.g. "… by shateer (MIT)."). */
  readonly credit: string;
}

/**
 * The full game data asset: the pool of playable claims plus the two credits.
 * The game picks 6 rounds from `claims` at runtime — both `isLie` claims always,
 * then 4 PASS claims at random — so the asset carries the whole verified pool
 * and the UI does the (seedable) sampling.
 */
export interface GameData {
  /** When this asset was generated (ISO). */
  readonly generatedAt: string;
  /** The verified pool of playable claims across both targets. */
  readonly claims: readonly GameClaim[];
  /** Per-target attribution lines. */
  readonly credits: readonly GameCredit[];
}

/** Site-root-relative URL of the generated game data asset. */
export const GAME_ASSET_PATH = "/reports/game.json";

/** The canonical public site URL, shared with the report page meta. */
export const SITE_URL = "https://d2xayupxggkiqt.cloudfront.net/";

/** The Kiroween hackathon hashtag used in the share text. */
export const SHARE_HASHTAG = "#KiroweenHackathon26";
