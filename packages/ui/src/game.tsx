/**
 * "Trust or Test?" mini-game (route #play).
 *
 * Gameplay: each round shows one REAL comment and the verbatim code it
 * describes (file:line, from the two targets). The player picks "Trust" (the
 * comment is true) or "Doubt" (it lies). The lantern then lights up and reveals
 * what EXECUTION proved — PASS, or FAIL with the counterexample in plain words.
 * Six rounds: both real lies plus four claims that held, drawn at random. The
 * final screen reads "You: N/6 · Kiro: M/6", where Kiro's answers are its
 * actual LOCKED predictions (PASS = Trust).
 *
 * All data comes from the build-time {@link GameData} asset
 * (public/reports/game.json) — generated from claims.json, locks/ and the
 * persisted results/ (report-data-fidelity). Nothing here is hand-authored and
 * NO network calls / tracking happen; the share button copies text + the static
 * site URL, and the X link is a plain intent URL.
 *
 * Accessibility: keyboard-operable buttons, a polite live region announcing the
 * reveal, a visible focus path, and colour never the sole signal (PASS/FAIL and
 * ✓/✗ carry text). The amber "light up" animation is disabled under
 * prefers-reduced-motion (in lantern-theme.css). Works down to 375px.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { GameClaim, GameData } from "./game-asset.js";
import {
  SHARE_HASHTAG,
  SITE_URL,
} from "./game-asset.js";
import {
  ROUNDS_PER_GAME,
  scoreRound,
  selectRounds,
  shareText,
  tallyGame,
  verdictToChoice,
  type Choice,
  type GameScore,
  type RoundResult,
} from "./game-logic.js";

/** Stable test ids for the game UI. */
export const GAME_TEST_IDS = {
  root: "game-root",
  intro: "game-intro",
  start: "game-start",
  round: "game-round",
  code: "game-code",
  claim: "game-claim",
  trust: "game-choice-trust",
  doubt: "game-choice-doubt",
  reveal: "game-reveal",
  verdict: "game-verdict",
  counterexample: "game-counterexample",
  rootCause: "game-root-cause",
  kiroPick: "game-kiro-pick",
  next: "game-next",
  progress: "game-progress",
  final: "game-final",
  finalScore: "game-final-score",
  share: "game-share",
  shareX: "game-share-x",
  playAgain: "game-play-again",
  credits: "game-credits",
  loadError: "game-load-error",
} as const;

/** Split an excerpt into display lines, stripping the CRLF carriage returns. */
function excerptLines(code: string): string[] {
  return code.split("\n").map((l) => l.replace(/\r$/, ""));
}

/* -------------------------------------------------------------------------- */
/* Code excerpt with the claim line highlighted                               */
/* -------------------------------------------------------------------------- */

interface CodeExcerptProps {
  readonly claim: GameClaim;
}

/**
 * Render the verbatim code excerpt as numbered lines, highlighting the claim
 * comment's line (offset `claimLine - startLine`). Line numbers are the real
 * source line numbers so a player can find the comment in the repo.
 */
function CodeExcerpt({ claim }: CodeExcerptProps): ReactElement {
  const lines = excerptLines(claim.code);
  const highlightIndex = claim.claimLine - claim.startLine;
  return (
    <pre
      className="game-code"
      data-testid={GAME_TEST_IDS.code}
      aria-label={`Code from ${claim.sourceLocation}`}
    >
      <code>
        {lines.map((line, i) => {
          const lineNo = claim.startLine + i;
          const isClaim = i === highlightIndex;
          return (
            <span
              key={lineNo}
              className={
                isClaim ? "game-code__line game-code__line--claim" : "game-code__line"
              }
              data-claim-line={isClaim ? "true" : undefined}
            >
              <span className="game-code__ln" aria-hidden="true">
                {lineNo}
              </span>
              <span className="game-code__text">{line === "" ? " " : line}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

/* -------------------------------------------------------------------------- */
/* One round                                                                  */
/* -------------------------------------------------------------------------- */

interface RoundViewProps {
  readonly claim: GameClaim;
  readonly index: number;
  readonly total: number;
  /** The player's answer once chosen, else null (not yet revealed). */
  readonly answered: Choice | null;
  readonly onChoose: (choice: Choice) => void;
  readonly onNext: () => void;
  readonly isLast: boolean;
}

/** One playable round: the claim + code, the two choices, then the reveal. */
function RoundView({
  claim,
  index,
  total,
  answered,
  onChoose,
  onNext,
  isLast,
}: RoundViewProps): ReactElement {
  const revealed = answered !== null;
  const playerCorrect = revealed && verdictToChoice(claim.verdict) === answered;
  const kiroPick = verdictToChoice(claim.kiroPrediction);
  const nextRef = useRef<HTMLButtonElement>(null);

  // Move focus to the Next button when the reveal appears, so a keyboard player
  // continues without hunting for it.
  useEffect(() => {
    if (revealed) nextRef.current?.focus();
  }, [revealed]);

  return (
    <div className="game-round" data-testid={GAME_TEST_IDS.round}>
      <p className="game-round__progress" data-testid={GAME_TEST_IDS.progress}>
        Round {index + 1} of {total}
      </p>

      <p className="game-round__prompt">
        <span className="game-round__target">{claim.targetLabel}</span>
        <span className="game-round__source"> · {claim.sourceLocation}</span>
      </p>

      <blockquote
        className="game-claim"
        data-testid={GAME_TEST_IDS.claim}
      >
        {claim.claimText}
      </blockquote>

      <CodeExcerpt claim={claim} />

      {!revealed ? (
        <div className="game-choices" role="group" aria-label="Is the comment true?">
          <button
            type="button"
            className="game-choice game-choice--trust"
            data-testid={GAME_TEST_IDS.trust}
            onClick={() => onChoose("trust")}
          >
            Trust
            <span className="game-choice__hint">the comment is true</span>
          </button>
          <button
            type="button"
            className="game-choice game-choice--doubt"
            data-testid={GAME_TEST_IDS.doubt}
            onClick={() => onChoose("doubt")}
          >
            Doubt
            <span className="game-choice__hint">it lies</span>
          </button>
        </div>
      ) : (
        <div
          className="game-reveal"
          data-testid={GAME_TEST_IDS.reveal}
          data-verdict={claim.verdict}
        >
          <p className="game-reveal__lantern" aria-hidden="true">
            🏮
          </p>
          <p
            className="game-reveal__verdict"
            data-testid={GAME_TEST_IDS.verdict}
            role="status"
          >
            <span className="game-reveal__badge" data-verdict={claim.verdict}>
              {claim.verdict === "PASS" ? "Execution: PASS" : "Execution: FAIL"}
            </span>{" "}
            {claim.verdict === "PASS"
              ? "the comment told the truth."
              : "the comment was lying."}{" "}
            <span className="game-reveal__you">
              You {playerCorrect ? "✓ got it" : "✗ were fooled"}.
            </span>
          </p>

          {claim.verdict === "FAIL" && claim.counterexamplePlain ? (
            <p
              className="game-reveal__counterexample"
              data-testid={GAME_TEST_IDS.counterexample}
            >
              {claim.counterexamplePlain}
            </p>
          ) : null}

          {claim.rootCauseNote ? (
            <p
              className="game-reveal__root-cause"
              data-testid={GAME_TEST_IDS.rootCause}
            >
              {claim.rootCauseNote}
            </p>
          ) : null}

          <p
            className="game-reveal__kiro"
            data-testid={GAME_TEST_IDS.kiroPick}
          >
            Kiro had predicted{" "}
            <strong>{kiroPick === "trust" ? "Trust" : "Doubt"}</strong>
            {" "}(its locked verdict was {claim.kiroPrediction}).
          </p>

          <button
            type="button"
            ref={nextRef}
            className="game-next"
            data-testid={GAME_TEST_IDS.next}
            onClick={onNext}
          >
            {isLast ? "See the score" : "Next round"}
          </button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Final screen                                                               */
/* -------------------------------------------------------------------------- */

interface FinalViewProps {
  readonly score: GameScore;
  readonly credits: GameData["credits"];
  readonly onPlayAgain: () => void;
}

/** The final screen: "You: N/6 · Kiro: M/6", share actions, and credits. */
function FinalView({ score, credits, onPlayAgain }: FinalViewProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const text = shareText(score);
  const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    `${text} ${SHARE_HASHTAG}`,
  )}&url=${encodeURIComponent(SITE_URL)}`;

  const onCopy = useCallback(() => {
    const full = `${text} ${SITE_URL}`;
    const clip = navigator.clipboard;
    if (clip && typeof clip.writeText === "function") {
      clip.writeText(full).then(
        () => setCopied(true),
        () => setCopied(false),
      );
    } else {
      setCopied(false);
    }
  }, [text]);

  return (
    <div className="game-final" data-testid={GAME_TEST_IDS.final}>
      <h2 className="game-final__title">The lantern is out.</h2>
      <p className="game-final__score" data-testid={GAME_TEST_IDS.finalScore}>
        <span className="game-final__you">You: {score.player}/{score.total}</span>
        <span className="game-final__dot" aria-hidden="true"> · </span>
        <span className="game-final__kiro">Kiro: {score.kiro}/{score.total}</span>
      </p>
      <p className="game-final__lies">
        You were fooled by {score.playerFooledByLies} of {score.lieCount} lying
        comments. Kiro was fooled by {score.kiroFooledByLies}.
      </p>

      <div className="game-final__actions">
        <button
          type="button"
          className="game-share"
          data-testid={GAME_TEST_IDS.share}
          onClick={onCopy}
          aria-live="polite"
        >
          {copied ? "Copied!" : "Copy result"}
        </button>
        <a
          className="game-share game-share--x"
          data-testid={GAME_TEST_IDS.shareX}
          href={xHref}
          target="_blank"
          rel="noreferrer noopener"
        >
          Share on X
        </a>
        <button
          type="button"
          className="game-play-again"
          data-testid={GAME_TEST_IDS.playAgain}
          onClick={onPlayAgain}
        >
          Play again
        </button>
      </div>

      <p className="game-credits" data-testid={GAME_TEST_IDS.credits}>
        Real comments and code from{" "}
        {credits.map((c, i) => (
          <span key={c.targetId}>
            {i > 0 ? " and " : ""}
            {c.credit.replace(/\.$/, "")}
          </span>
        ))}
        . Every verdict was produced by executing the code, never by trusting the
        comment.
      </p>

      <p className="game-final__back">
        <a className="game-final__link" href="#">
          ← Back to the report
        </a>
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Game                                                                       */
/* -------------------------------------------------------------------------- */

export interface GameViewProps {
  /** The loaded game data, or null while loading / on error. */
  readonly data: GameData | null;
  /**
   * Seed for round selection. Defaults to a time-based seed so each play is
   * fresh; tests pass a fixed seed for determinism.
   */
  readonly seed?: number;
}

type Phase =
  | { readonly kind: "intro" }
  | { readonly kind: "playing"; readonly roundIndex: number; readonly answered: Choice | null }
  | { readonly kind: "final" };

/**
 * The top-level game view. Pure w.r.t. data: it receives the loaded
 * {@link GameData} as a prop (the route wrapper does the fetch), so it renders
 * synchronously and is easy to test. When `data` is null it shows a short
 * "could not load" message (no network retry, no tracking).
 */
export function GameView({ data, seed }: GameViewProps): ReactElement {
  const [gameSeed, setGameSeed] = useState<number>(
    () => seed ?? (Date.now() & 0x7fffffff),
  );
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [results, setResults] = useState<RoundResult[]>([]);

  const rounds = useMemo(
    () => (data ? selectRounds(data, gameSeed) : []),
    [data, gameSeed],
  );

  const startGame = useCallback(() => {
    setResults([]);
    setPhase({ kind: "playing", roundIndex: 0, answered: null });
  }, []);

  const playAgain = useCallback(() => {
    // New seed -> new random held-claim draw and order.
    setGameSeed((Date.now() & 0x7fffffff) ^ (results.length + 1));
    setResults([]);
    setPhase({ kind: "intro" });
  }, [results.length]);

  const choose = useCallback(
    (choice: Choice) => {
      setPhase((p) => {
        if (p.kind !== "playing" || p.answered !== null) return p;
        const claim = rounds[p.roundIndex];
        setResults((rs) => [...rs, scoreRound(claim, choice)]);
        return { ...p, answered: choice };
      });
    },
    [rounds],
  );

  const next = useCallback(() => {
    setPhase((p) => {
      if (p.kind !== "playing") return p;
      const nextIndex = p.roundIndex + 1;
      if (nextIndex >= rounds.length) return { kind: "final" };
      return { kind: "playing", roundIndex: nextIndex, answered: null };
    });
  }, [rounds.length]);

  if (!data) {
    return (
      <section className="game" data-testid={GAME_TEST_IDS.root}>
        <p className="game-load-error" data-testid={GAME_TEST_IDS.loadError}>
          The game could not load. Try refreshing the page.
        </p>
      </section>
    );
  }

  const score = tallyGame(results);

  return (
    <section className="game" data-testid={GAME_TEST_IDS.root} aria-label="Trust or Test? mini-game">
      <header className="game-header">
        <h1 className="game-header__title">
          <span aria-hidden="true">🏮</span> Trust or Test?
        </h1>
        <p className="game-header__tagline">
          A real comment. The real code. Do you trust it — or do you test it?
        </p>
      </header>

      {phase.kind === "intro" ? (
        <div className="game-intro" data-testid={GAME_TEST_IDS.intro}>
          <p>
            {ROUNDS_PER_GAME} rounds. Each shows a real code comment from an
            AI-built app and the code it describes. Decide if the comment tells
            the truth (<strong>Trust</strong>) or lies (<strong>Doubt</strong>).
            Then the lantern reveals what spec-lantern proved by executing the
            code — and whether Kiro was fooled too.
          </p>
          <p className="game-intro__fine">
            Two of the comments really lie. The rest held up under execution.
            Kiro's answers are its own locked predictions.
          </p>
          <button
            type="button"
            className="game-start"
            data-testid={GAME_TEST_IDS.start}
            onClick={startGame}
          >
            Light the first lantern
          </button>
          <p className="game-credits" data-testid={GAME_TEST_IDS.credits}>
            Real comments and code from{" "}
            {data.credits.map((c, i) => (
              <span key={c.targetId}>
                {i > 0 ? " and " : ""}
                {c.credit.replace(/\.$/, "")}
              </span>
            ))}
            .
          </p>
        </div>
      ) : null}

      {phase.kind === "playing" ? (
        <RoundView
          claim={rounds[phase.roundIndex]}
          index={phase.roundIndex}
          total={rounds.length}
          answered={phase.answered}
          onChoose={choose}
          onNext={next}
          isLast={phase.roundIndex === rounds.length - 1}
        />
      ) : null}

      {phase.kind === "final" ? (
        <FinalView score={score} credits={data.credits} onPlayAgain={playAgain} />
      ) : null}
    </section>
  );
}
