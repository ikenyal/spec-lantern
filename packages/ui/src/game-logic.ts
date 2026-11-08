/**
 * Pure game logic for "Trust or Test?": round selection, scoring, and the
 * mapping from a verdict to a Trust/Doubt answer. No React, no DOM — so it is
 * trivially unit-tested and the component stays a thin renderer.
 *
 * SELECTION (the spec's "6 rounds per game: both real lies plus 4 claims that
 * held, drawn at random"):
 *   - the TWO `isLie` claims are ALWAYS included (the real lies);
 *   - FOUR more are drawn at random from the claims that HELD (verdict PASS);
 *   - the six are then shuffled so the two lies are not always first.
 * A symptom claim (FAIL but not a lie, e.g. MoodPlays property-6) is neither a
 * lie slot nor a "held" slot, so it is not normally drawn; the renderer still
 * handles its `rootCauseNote` should it ever appear.
 *
 * SCORING: the player picks "trust" (bets the comment is true -> PASS) or
 * "doubt" (bets it lies -> FAIL). A pick is correct when it matches the
 * executed verdict. Kiro's answer is derived from its LOCKED prediction the
 * same way (PASS -> trust), so "Kiro fooled" counts the locked predictions that
 * the execution disproved.
 */
import type { GameClaim, GameData, GameVerdict } from "./game-asset.js";

/** The player's (or Kiro's) choice for a round. */
export type Choice = "trust" | "doubt";

/** The number of rounds in one game. */
export const ROUNDS_PER_GAME = 6;

/** The number of `isLie` claims every game must contain. */
export const REQUIRED_LIES = 2;

/** How a verdict maps to the Trust/Doubt answer: a true comment -> trust. */
export function verdictToChoice(verdict: GameVerdict): Choice {
  return verdict === "PASS" ? "trust" : "doubt";
}

/** Whether a Trust/Doubt choice is correct against the executed verdict. */
export function isChoiceCorrect(choice: Choice, verdict: GameVerdict): boolean {
  return choice === verdictToChoice(verdict);
}

/** Kiro's answer for a claim, derived from its locked prediction. */
export function kiroChoice(claim: GameClaim): Choice {
  return verdictToChoice(claim.kiroPrediction);
}

/** Whether Kiro was fooled on a claim: its locked prediction != the verdict. */
export function kiroWasFooled(claim: GameClaim): boolean {
  return !isChoiceCorrect(kiroChoice(claim), claim.verdict);
}

/**
 * A deterministic, seedable shuffle (Fisher–Yates with a small LCG) so a game
 * is reproducible from a seed in tests, while the component seeds from
 * `Date.now()` for a fresh order each play. Pure: returns a new array.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  // LCG constants (Numerical Recipes); state kept positive and non-zero.
  let state = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Select the six rounds for a game from the full claim pool: both `isLie`
 * claims plus four claims that held (PASS), drawn at random with `seed`, then
 * the six shuffled together.
 *
 * Throws when the pool cannot support a game (not exactly two lies, or fewer
 * than four held claims) — the generator already guarantees this, so a throw
 * here means the asset was tampered with.
 */
export function selectRounds(data: GameData, seed: number): GameClaim[] {
  const lies = data.claims.filter((c) => c.isLie);
  const held = data.claims.filter((c) => c.verdict === "PASS" && !c.isLie);

  if (lies.length !== REQUIRED_LIES) {
    throw new Error(
      `expected ${REQUIRED_LIES} lie claims, found ${lies.length}`,
    );
  }
  const needHeld = ROUNDS_PER_GAME - REQUIRED_LIES;
  if (held.length < needHeld) {
    throw new Error(
      `need ${needHeld} held claims, found ${held.length}`,
    );
  }

  // Draw the held claims with one seed, then shuffle the combined six with a
  // derived seed so the two seeds never coincide (which would correlate the
  // draw order with the final order).
  const drawnHeld = seededShuffle(held, seed).slice(0, needHeld);
  return seededShuffle([...lies, ...drawnHeld], seed ^ 0x5bd1e995);
}

/** The outcome of one answered round. */
export interface RoundResult {
  readonly claim: GameClaim;
  readonly playerChoice: Choice;
  readonly playerCorrect: boolean;
  readonly kiroCorrect: boolean;
}

/** A completed game's tally. */
export interface GameScore {
  /** How many rounds the player got right. */
  readonly player: number;
  /** How many rounds Kiro (its locked predictions) got right. */
  readonly kiro: number;
  /** Total rounds. */
  readonly total: number;
  /** How many of the lie rounds the player was fooled by (trusted a lie). */
  readonly playerFooledByLies: number;
  /** How many lie rounds were in the game (always {@link REQUIRED_LIES}). */
  readonly lieCount: number;
  /** How many lie rounds Kiro was fooled by. */
  readonly kiroFooledByLies: number;
}

/** Score one answered round. */
export function scoreRound(claim: GameClaim, playerChoice: Choice): RoundResult {
  return {
    claim,
    playerChoice,
    playerCorrect: isChoiceCorrect(playerChoice, claim.verdict),
    kiroCorrect: !kiroWasFooled(claim),
  };
}

/** Tally a finished game from its per-round results. */
export function tallyGame(results: readonly RoundResult[]): GameScore {
  let player = 0;
  let kiro = 0;
  let playerFooledByLies = 0;
  let lieCount = 0;
  let kiroFooledByLies = 0;
  for (const r of results) {
    if (r.playerCorrect) player += 1;
    if (r.kiroCorrect) kiro += 1;
    if (r.claim.isLie) {
      lieCount += 1;
      // Fooled by a lie = trusted it (the choice was wrong on a FAIL claim).
      if (!r.playerCorrect) playerFooledByLies += 1;
      if (kiroWasFooled(r.claim)) kiroFooledByLies += 1;
    }
  }
  return {
    player,
    kiro,
    total: results.length,
    playerFooledByLies,
    lieCount,
    kiroFooledByLies,
  };
}

/**
 * The share text: "I was fooled by X of N lying comments. Kiro was fooled by Y.
 * Can you beat it?" — built from the finished score. Pure string; the component
 * appends the site URL / hashtag per channel.
 */
export function shareText(score: GameScore): string {
  return (
    `I was fooled by ${score.playerFooledByLies} of ${score.lieCount} lying ` +
    `comments. Kiro was fooled by ${score.kiroFooledByLies}. Can you beat it?`
  );
}
