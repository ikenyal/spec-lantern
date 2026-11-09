// @vitest-environment jsdom
/**
 * Tests for the MoodPlays report + story (Stage E), asserted against the REAL
 * assembled report data (src/moodplays-report.ts). A fabricated/drifted value
 * would fail these (report-data-fidelity).
 *
 * Focus of the correction being verified:
 *   - property-1 (tied to the 24h-detection root cause) shows "Lie exposed".
 *   - property-6 keeps its factual data (FAIL counterexample, FIXED transition)
 *     but shows "Symptom of the 24h-detection bug", NOT "Lie exposed".
 *   - the story stats say exactly "1 lie".
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { PropertyComparison } from "@spec-lantern/types";
import {
  LanternReportView,
  TEST_IDS,
  countLies,
  summarize,
} from "./index.js";
import { MOODPLAYS_REPORT, MOODPLAYS_STORY } from "./moodplays-report.js";

afterEach(cleanup);

function renderMoodplays() {
  render(
    <LanternReportView
      report={MOODPLAYS_REPORT}
      story={MOODPLAYS_STORY}
      targetLabel="MoodPlays (abandoned Lovable app)"
    />,
  );
}

describe("MoodPlays report rows", () => {
  it("property-1 shows 'Lie exposed' (the 24h-detection root cause)", () => {
    renderMoodplays();
    const el = screen.getByTestId(TEST_IDS.mismatch("property-1.claim-24h-to-minutes"));
    expect(el.textContent).toContain("Lie exposed");
    // It is NOT labeled a symptom.
    expect(screen.queryByTestId(TEST_IDS.symptom("property-1.claim-24h-to-minutes"))).toBeNull();
  });

  it("property-6 shows 'Symptom of the 24h-detection bug', not 'Lie exposed'", () => {
    renderMoodplays();
    const sym = screen.getByTestId(TEST_IDS.symptom("property-6.claim-stale-closed"));
    expect(sym.textContent).toContain("Symptom of the 24h-detection bug");
    expect(sym.textContent).toContain("this comment itself holds");
    // The lie indicator is absent on property-6.
    expect(screen.queryByTestId(TEST_IDS.mismatch("property-6.claim-stale-closed"))).toBeNull();
  });

  it("property-6 keeps its factual data: FAIL actual + FIXED transition", () => {
    renderMoodplays();
    // Actual verdict FAIL is rendered.
    expect(
      screen.getByTestId(TEST_IDS.actual("property-6.claim-stale-closed")).textContent,
    ).toContain("FAIL");
    // The transition is present (pre FAIL -> post PASS).
    const t = screen.getByTestId(TEST_IDS.transition("property-6.claim-stale-closed"));
    expect(t.textContent).toContain("FAIL");
    expect(t.textContent).toContain("PASS");
    // The counterexample evidence card is present (Confirmed_Bug row).
    expect(
      screen.getByTestId(TEST_IDS.counterexample("property-6.claim-stale-closed")),
    ).toBeTruthy();
  });

  it("only property-1 is labeled a lie across all 10 rows", () => {
    renderMoodplays();
    const lieEls = screen.queryAllByText("Lie exposed");
    expect(lieEls).toHaveLength(1);
  });
});

describe("computed lie count (excludes symptomOf rows)", () => {
  it("countLies counts only non-symptom confirmed bugs (MoodPlays = 1, though 2 are confirmed bugs)", () => {
    const confirmed = MOODPLAYS_REPORT.comparisons.filter((c) => c.confirmedBug);
    expect(confirmed).toHaveLength(2); // property-1 + property-6 both FAILed
    expect(countLies(MOODPLAYS_REPORT.comparisons)).toBe(1); // only property-1 is a lie
  });

  it("summarize().exposed uses the same symptom-aware count (1 for MoodPlays)", () => {
    expect(summarize(MOODPLAYS_REPORT.comparisons).exposed).toBe(1);
  });

  it("the rendered stats line reads '1 lie', computes 'Kiro fooled 1/10', never '2 lies'", () => {
    renderMoodplays();
    const stats = screen.getByTestId(TEST_IDS.storyStats).textContent ?? "";
    expect(stats).toContain("1 lie");
    expect(stats).toContain("Kiro fooled 1/10"); // lies / claims checked, computed
    expect(stats).not.toContain("2 lies");
    // Tokens were substituted, not shown literally.
    expect(stats).not.toContain("{lies}");
    expect(stats).not.toContain("{fooled}");
  });

  it("two symptom rows + one lie still counts as one lie", () => {
    const mk = (id: string, symptomOf?: string): PropertyComparison => ({
      propertyId: id,
      predicted: "PASS",
      actual: { propertyId: id, outcome: "VERDICT", verdict: "FAIL" },
      status: "PREDICTION_MISMATCH",
      confirmedBug: true,
      display: symptomOf ? { symptomOf } : undefined,
    });
    const comparisons = [mk("root"), mk("sym-a", "root bug"), mk("sym-b", "root bug")];
    expect(countLies(comparisons)).toBe(1);
    expect(summarize(comparisons).exposed).toBe(1);
  });

  it("a confirmed bug whose predicted == actual (MATCH) still counts as a lie", () => {
    // Kiro predicted FAIL and execution FAILed, so the prediction MATCHED — but
    // the comment is still a confirmed lying claim. Lie counting is
    // confirmedBug-based, not mismatch-based, so this row is a lie.
    const matchedBug: PropertyComparison = {
      propertyId: "matched-bug",
      predicted: "FAIL",
      actual: { propertyId: "matched-bug", outcome: "VERDICT", verdict: "FAIL" },
      status: "MATCH",
      confirmedBug: true,
    };
    expect(countLies([matchedBug])).toBe(1);
    expect(summarize([matchedBug]).exposed).toBe(1);
  });
});

describe("MoodPlays story", () => {
  it("the page headline is the shared PRODUCT thesis, with the MoodPlays sentence as subhead", () => {
    renderMoodplays();
    // The headline is the product thesis, shared with writing-tracker.
    expect(screen.getByTestId(TEST_IDS.storyThesis).textContent).toBe(
      "AI-built apps are full of comments that lie — and AI reviewers believe them. spec-lantern makes Kiro predict, then executes, then proves.",
    );
    // The MoodPlays-specific sentence appears below it.
    const subhead = screen.getByTestId(TEST_IDS.storySubhead);
    expect(subhead.textContent).toContain('check for 24 hours');
    expect(subhead.textContent).toContain('the characters "24"');
    const stats = screen.getByTestId(TEST_IDS.storyStats).textContent ?? "";
    expect(stats).toBe(
      "10 claims checked · 1 lie · Kiro fooled 1/10 · fixed in 2 lines",
    );
  });

  it("step 1 quotes ONLY the L51 check (not the L53 'never closing' comment)", () => {
    renderMoodplays();
    const step = screen.getByTestId(TEST_IDS.storyStep(1));
    expect(step.textContent).toContain("// Check for 24 hours");
    expect(step.textContent).toContain("openingHoursParser.ts:51");
    // The L53 comment is NOT quoted as the lie (property-4 shows it Matches).
    expect(step.textContent).not.toContain("Open 24 hours, never closing");
  });

  it("property-4's row carries the 'holds for real 24-hour places' note", () => {
    renderMoodplays();
    const note = screen.getByTestId(
      TEST_IDS.claimNote("property-4.claim-24h-never-closing"),
    );
    expect(note.textContent).toContain("Holds for real 24-hour places");
    expect(note.textContent).toContain("non-24h times containing '24'");
  });

  it("the evidence cards for properties 1 and 6 show expected close vs no close time", () => {
    renderMoodplays();
    const c1 = screen.getByTestId(
      TEST_IDS.counterexample("property-1.claim-24h-to-minutes"),
    );
    expect(c1.textContent).toContain("close 13:24");
    expect(c1.textContent).toContain("no close time (treated as open 24 hours)");
    // The triggering input is still in the raw details.
    expect(
      screen.getByTestId(
        TEST_IDS.counterexampleInput("property-1.claim-24h-to-minutes"),
      ).textContent,
    ).toContain('"closeHour":13');

    const c6 = screen.getByTestId(
      TEST_IDS.counterexample("property-6.claim-stale-closed"),
    );
    expect(c6.textContent).toContain("close 00:24");
    expect(c6.textContent).toContain("no close time (treated as open 24 hours)");
  });

  it("step 3 shows both counterexample evidence lines and the user impact", () => {
    renderMoodplays();
    const ev = screen.getByTestId(TEST_IDS.storyEvidence);
    expect(ev.textContent).toContain("00:00-13:24");
    expect(ev.textContent).toContain("08:00-00:24");
    const step = screen.getByTestId(TEST_IDS.storyStep(3));
    expect(step.textContent).toContain("treated as open 24 hours");
    expect(step.textContent).toContain("never show");
  });

  it("step 4 shows the 2-line fix diff and both FIXED symptoms with no month table", () => {
    renderMoodplays();
    const diff = screen.getByTestId(TEST_IDS.storyDiff);
    expect(diff.textContent).toContain("openingHours.toLowerCase().includes('24')");
    expect(diff.textContent).toContain("/24\\s*(?:hours?|hrs?|\\/7)/i.test(openingHours)");
    // No writing-tracker month-table mock in the MoodPlays story.
    expect(screen.queryByTestId(TEST_IDS.storyMonths)).toBeNull();
  });

  it("shows the target-selection note (linking the doc) and the MoodPlays credit", () => {
    renderMoodplays();
    const sel = screen.getByTestId(TEST_IDS.storySelection);
    expect(sel.textContent).toContain("docs/target-selection.md");
    expect(sel.textContent).toContain("before any claim was verified");
    expect(screen.getByTestId(TEST_IDS.storyCredit).textContent).toBe(
      "MoodPlays by Gargi Sahu (MIT).",
    );
  });

  it("header label names the MoodPlays target", () => {
    renderMoodplays();
    expect(screen.getByTestId(TEST_IDS.subheader).textContent).toContain(
      "MoodPlays (abandoned Lovable app)",
    );
  });
});
