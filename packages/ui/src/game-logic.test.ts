/**
 * Tests for the pure "Trust or Test?" game logic (./game-logic.ts): the
 * verdict→choice mapping, scoring (player + Kiro from locked predictions),
 * seedable round selection, and the share text.
 */
import { describe, it, expect } from "vitest";
import type { GameClaim, GameData, GameVerdict } from "./game-asset.js";
import {
  REQUIRED_LIES,
  ROUNDS_PER_GAME,
  isChoiceCorrect,
  kiroChoice,
  kiroWasFooled,
  scoreRound,
  seededShuffle,
  selectRounds,
  shareText,
  tallyGame,
  verdictToChoice,
} from "./game-logic.js";

function claim(
  propertyId: string,
  verdict: GameVerdict,
  kiroPrediction: GameVerdict,
  isLie: boolean,
): GameClaim {
  return {
    propertyId,
    targetId: "t",
    targetLabel: "T",
    claimText: "// c",
    sourceLocation: "f:1",
    code: "x",
    sourceFile: "sandbox/f.ts",
    startLine: 1,
    endLine: 1,
    claimLine: 1,
    verdict,
    kiroPrediction,
    isLie,
  };
}

describe("verdict/choice mapping", () => {
  it("PASS maps to trust, FAIL to doubt", () => {
    expect(verdictToChoice("PASS")).toBe("trust");
    expect(verdictToChoice("FAIL")).toBe("doubt");
  });

  it("a choice is correct when it matches the verdict", () => {
    expect(isChoiceCorrect("trust", "PASS")).toBe(true);
    expect(isChoiceCorrect("doubt", "PASS")).toBe(false);
    expect(isChoiceCorrect("doubt", "FAIL")).toBe(true);
    expect(isChoiceCorrect("trust", "FAIL")).toBe(false);
  });

  it("derives Kiro's choice from its locked prediction and whether it was fooled", () => {
    // Kiro predicted PASS (trust) on a lie (FAIL) -> fooled.
    const lie = claim("p1", "FAIL", "PASS", true);
    expect(kiroChoice(lie)).toBe("trust");
    expect(kiroWasFooled(lie)).toBe(true);

    // Kiro predicted PASS (trust) on a held claim (PASS) -> correct.
    const held = claim("p2", "PASS", "PASS", false);
    expect(kiroWasFooled(held)).toBe(false);
  });
});

describe("scoring", () => {
  it("scoreRound reports player + Kiro correctness", () => {
    const lie = claim("p1", "FAIL", "PASS", true);
    // Player doubted the lie -> correct; Kiro trusted it -> wrong.
    const doubted = scoreRound(lie, "doubt");
    expect(doubted.playerCorrect).toBe(true);
    expect(doubted.kiroCorrect).toBe(false);
    // Player trusted the lie -> fooled.
    const trusted = scoreRound(lie, "trust");
    expect(trusted.playerCorrect).toBe(false);
  });

  it("tallyGame counts player, Kiro, and fooled-by-lies", () => {
    const rounds = [
      scoreRound(claim("p1", "FAIL", "PASS", true), "trust"), // fooled by lie
      scoreRound(claim("p2", "FAIL", "PASS", true), "doubt"), // caught lie
      scoreRound(claim("p3", "PASS", "PASS", false), "trust"), // right
      scoreRound(claim("p4", "PASS", "PASS", false), "doubt"), // wrong
    ];
    const score = tallyGame(rounds);
    expect(score.total).toBe(4);
    expect(score.player).toBe(2); // caught lie + trusted held
    expect(score.kiro).toBe(2); // Kiro right on the two PASS rows
    expect(score.lieCount).toBe(2);
    expect(score.playerFooledByLies).toBe(1); // trusted one lie
    expect(score.kiroFooledByLies).toBe(2); // Kiro trusted both lies
  });
});

describe("seededShuffle", () => {
  it("is deterministic for a given seed and a permutation of the input", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = seededShuffle(items, 42);
    const b = seededShuffle(items, 42);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    // A different seed generally yields a different order.
    expect(seededShuffle(items, 43)).not.toEqual(a);
  });

  it("does not mutate the input", () => {
    const items = [1, 2, 3];
    seededShuffle(items, 1);
    expect(items).toEqual([1, 2, 3]);
  });
});

describe("selectRounds", () => {
  function pool(): GameData {
    return {
      generatedAt: "x",
      claims: [
        claim("lie1", "FAIL", "PASS", true),
        claim("lie2", "FAIL", "PASS", true),
        claim("h1", "PASS", "PASS", false),
        claim("h2", "PASS", "PASS", false),
        claim("h3", "PASS", "PASS", false),
        claim("h4", "PASS", "PASS", false),
        claim("h5", "PASS", "PASS", false),
        claim("h6", "PASS", "PASS", false),
        // A symptom: FAIL but not a lie — must NOT be drawn.
        claim("sym", "FAIL", "PASS", false),
      ],
      credits: [],
    };
  }

  it("always includes both lies and fills to six with held claims", () => {
    const rounds = selectRounds(pool(), 7);
    expect(rounds).toHaveLength(ROUNDS_PER_GAME);
    const lies = rounds.filter((r) => r.isLie);
    expect(lies).toHaveLength(REQUIRED_LIES);
    expect(new Set(lies.map((r) => r.propertyId))).toEqual(
      new Set(["lie1", "lie2"]),
    );
  });

  it("never draws a symptom (FAIL, not a lie) into the held slots", () => {
    for (const seed of [1, 2, 3, 99, 1234]) {
      const rounds = selectRounds(pool(), seed);
      expect(rounds.some((r) => r.propertyId === "sym")).toBe(false);
      // every non-lie round is a held (PASS) claim
      for (const r of rounds) {
        if (!r.isLie) expect(r.verdict).toBe("PASS");
      }
    }
  });

  it("is deterministic for a fixed seed", () => {
    const a = selectRounds(pool(), 123).map((r) => r.propertyId);
    const b = selectRounds(pool(), 123).map((r) => r.propertyId);
    expect(a).toEqual(b);
  });

  it("throws when the pool cannot support a game", () => {
    const short: GameData = {
      generatedAt: "x",
      claims: [
        claim("lie1", "FAIL", "PASS", true),
        claim("lie2", "FAIL", "PASS", true),
        claim("h1", "PASS", "PASS", false),
      ],
      credits: [],
    };
    expect(() => selectRounds(short, 1)).toThrow(/held claims/);
  });
});

describe("shareText", () => {
  it("renders the fooled-by counts", () => {
    const score = tallyGame([
      scoreRound(claim("p1", "FAIL", "PASS", true), "trust"),
      scoreRound(claim("p2", "FAIL", "PASS", true), "doubt"),
    ]);
    expect(shareText(score)).toBe(
      "I was fooled by 1 of 2 lying comments. Kiro was fooled by 2. Can you beat it?",
    );
  });
});
