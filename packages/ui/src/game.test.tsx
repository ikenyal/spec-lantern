// @vitest-environment jsdom
/**
 * Rendering tests for the "Trust or Test?" game view (./game.tsx).
 *
 * Driven with a small fixed-seed {@link GameData} so the six rounds and their
 * order are deterministic. Covers: the intro + credits, a full play-through of
 * all six rounds, the reveal (verdict badge, player ✓/✗, counterexample,
 * root-cause note, Kiro's locked prediction), the final "You: N/6 · Kiro: M/6"
 * score + share text, and the null-data load-error state.
 *
 * Matchers follow the project convention (components.test.tsx): plain DOM
 * assertions via `.textContent` / `.getAttribute`, not jest-dom.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { GameClaim, GameData, GameVerdict } from "./game-asset.js";
import { GameView, GAME_TEST_IDS } from "./game.js";
import { selectRounds } from "./game-logic.js";

afterEach(cleanup);

function claim(
  propertyId: string,
  verdict: GameVerdict,
  kiroPrediction: GameVerdict,
  isLie: boolean,
  extra: Partial<GameClaim> = {},
): GameClaim {
  return {
    propertyId,
    targetId: "demo",
    targetLabel: "Demo",
    claimText: `// claim ${propertyId}`,
    sourceLocation: `file.ts:${propertyId}`,
    code: "lineA\nlineB\nlineC",
    sourceFile: "sandbox/demo/file.ts",
    startLine: 10,
    endLine: 12,
    claimLine: 11,
    verdict,
    kiroPrediction,
    isLie,
    ...extra,
  };
}

const DATA: GameData = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  claims: [
    claim("lie1", "FAIL", "PASS", true, {
      counterexamplePlain: "Expected X; execution produced Y.",
    }),
    claim("lie2", "FAIL", "PASS", true, {
      counterexamplePlain: "Expected A; execution produced B.",
    }),
    claim("h1", "PASS", "PASS", false),
    claim("h2", "PASS", "PASS", false),
    claim("h3", "PASS", "PASS", false),
    claim("h4", "PASS", "PASS", false),
  ],
  credits: [
    { targetId: "demo", credit: "Demo by someone (MIT)." },
    { targetId: "demo2", credit: "Other by nobody (MIT)." },
  ],
};

const SEED = 123;

/** Play through the game by always choosing `choice`, asserting round count. */
function playAll(choice: "trust" | "doubt"): void {
  const rounds = selectRounds(DATA, SEED);
  for (let i = 0; i < rounds.length; i++) {
    expect(screen.getByTestId(GAME_TEST_IDS.progress).textContent).toContain(
      `Round ${i + 1} of 6`,
    );
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS[choice]));
    // reveal appears
    expect(screen.getByTestId(GAME_TEST_IDS.reveal)).toBeTruthy();
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.next));
  }
}

describe("GameView intro", () => {
  it("shows the intro, credits, and a start button", () => {
    render(<GameView data={DATA} seed={SEED} />);
    expect(screen.getByTestId(GAME_TEST_IDS.intro)).toBeTruthy();
    const credits = screen.getByTestId(GAME_TEST_IDS.credits).textContent ?? "";
    expect(credits).toContain("Demo by someone (MIT)");
    expect(credits).toContain("Other by nobody (MIT)");
    expect(screen.getByTestId(GAME_TEST_IDS.start)).toBeTruthy();
  });

  it("shows a load-error state when data is null", () => {
    render(<GameView data={null} />);
    expect(screen.getByTestId(GAME_TEST_IDS.loadError)).toBeTruthy();
    expect(screen.queryByTestId(GAME_TEST_IDS.intro)).toBeNull();
  });
});

describe("GameView rounds", () => {
  it("renders the claim, the code excerpt with the claim line highlighted, and both choices", () => {
    render(<GameView data={DATA} seed={SEED} />);
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.start));

    const rounds = selectRounds(DATA, SEED);
    const first = rounds[0];
    expect(screen.getByTestId(GAME_TEST_IDS.claim).textContent).toContain(
      first.claimText,
    );

    const code = screen.getByTestId(GAME_TEST_IDS.code);
    // line numbers are the real source lines 10..12
    expect(code.textContent).toContain("10");
    expect(code.textContent).toContain("12");
    // the highlighted line is claimLine (11) -> offset 1 -> "lineB"
    const highlighted = code.querySelector('[data-claim-line="true"]');
    expect(highlighted).not.toBeNull();
    expect(highlighted?.textContent).toContain("lineB");

    expect(screen.getByTestId(GAME_TEST_IDS.trust)).toBeTruthy();
    expect(screen.getByTestId(GAME_TEST_IDS.doubt)).toBeTruthy();
  });

  it("reveals the executed verdict, the player's result, and Kiro's locked prediction", () => {
    render(<GameView data={DATA} seed={SEED} />);
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.start));

    const rounds = selectRounds(DATA, SEED);
    const first = rounds[0];
    // Doubt the first round.
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.doubt));

    const reveal = screen.getByTestId(GAME_TEST_IDS.reveal);
    expect(reveal.getAttribute("data-verdict")).toBe(first.verdict);

    const verdict = screen.getByTestId(GAME_TEST_IDS.verdict).textContent ?? "";
    expect(verdict).toContain(
      first.verdict === "PASS" ? "Execution: PASS" : "Execution: FAIL",
    );
    // Doubting a FAIL is correct; doubting a PASS is wrong.
    expect(verdict).toContain(first.verdict === "FAIL" ? "got it" : "were fooled");

    // Kiro's locked prediction is shown (all PASS -> Trust).
    const kiro = screen.getByTestId(GAME_TEST_IDS.kiroPick).textContent ?? "";
    expect(kiro).toContain("Trust");
    expect(kiro).toContain(first.kiroPrediction);

    // A FAIL round shows the plain counterexample.
    if (first.verdict === "FAIL") {
      expect(
        screen.getByTestId(GAME_TEST_IDS.counterexample).textContent,
      ).toContain("execution produced");
    }
  });

  it("shows a root-cause note for a symptom-style claim when one appears", () => {
    // selectRounds excludes a FAIL-but-not-lie symptom from the drawn slots, so
    // to exercise the renderer's rootCauseNote path we attach the note to one of
    // the two always-included lie rows (a real symptom row carries one too).
    const symptom = claim("sym", "FAIL", "PASS", false, {
      rootCauseNote: "Not a lie on its own — symptom of the 24h-detection bug.",
      counterexamplePlain: "Expected close 00:24; execution produced nothing.",
    });
    const data: GameData = {
      generatedAt: "x",
      claims: [
        { ...symptom, isLie: true },
        claim("lie2", "FAIL", "PASS", true),
        claim("h1", "PASS", "PASS", false),
        claim("h2", "PASS", "PASS", false),
        claim("h3", "PASS", "PASS", false),
        claim("h4", "PASS", "PASS", false),
      ],
      credits: [],
    };
    render(<GameView data={data} seed={SEED} />);
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.start));
    const rounds = selectRounds(data, SEED);
    let sawNote = false;
    for (let i = 0; i < rounds.length; i++) {
      fireEvent.click(screen.getByTestId(GAME_TEST_IDS.doubt));
      if (rounds[i].propertyId === "sym") {
        expect(
          screen.getByTestId(GAME_TEST_IDS.rootCause).textContent,
        ).toContain("24h-detection bug");
        sawNote = true;
      }
      fireEvent.click(screen.getByTestId(GAME_TEST_IDS.next));
    }
    expect(sawNote).toBe(true);
  });
});

describe("GameView final screen", () => {
  it("shows You: N/6 · Kiro: M/6 and the fooled-by line when the player doubts everything", () => {
    render(<GameView data={DATA} seed={SEED} />);
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.start));
    playAll("doubt");

    const final = screen.getByTestId(GAME_TEST_IDS.final);
    expect(final).toBeTruthy();
    const scoreEl = screen.getByTestId(GAME_TEST_IDS.finalScore).textContent ?? "";
    // Doubting everything: player catches the 2 lies (FAIL) but misses all 4
    // held (PASS) -> 2/6. Kiro trusted everything (all locked PASS) -> catches
    // the 4 held, misses the 2 lies -> 4/6.
    expect(scoreEl).toContain("You: 2/6");
    expect(scoreEl).toContain("Kiro: 4/6");

    // The lies line: player fooled by 0 lies (doubted both); Kiro by 2.
    expect(final.textContent).toContain(
      "You were fooled by 0 of 2 lying comments. Kiro was fooled by 2.",
    );
  });

  it("copies share text with the site URL via the clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<GameView data={DATA} seed={SEED} />);
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.start));
    playAll("doubt");

    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.share));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("I was fooled by 0 of 2 lying comments");
    expect(copied).toContain("Kiro was fooled by 2");
    expect(copied).toContain("https://");

    // The X share link is a plain intent URL carrying the hashtag.
    const xLink = screen.getByTestId(GAME_TEST_IDS.shareX);
    expect(xLink.getAttribute("href")).toContain("twitter.com/intent/tweet");
    expect(decodeURIComponent(xLink.getAttribute("href") ?? "")).toContain(
      "#KiroweenHackathon26",
    );
  });

  it("lets the player start a fresh game from the final screen", () => {
    render(<GameView data={DATA} seed={SEED} />);
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.start));
    playAll("trust");
    fireEvent.click(screen.getByTestId(GAME_TEST_IDS.playAgain));
    expect(screen.getByTestId(GAME_TEST_IDS.intro)).toBeTruthy();
  });
});
