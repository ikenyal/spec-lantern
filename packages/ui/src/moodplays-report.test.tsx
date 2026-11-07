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
import { LanternReportView, TEST_IDS } from "./index.js";
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

describe("MoodPlays story", () => {
  it("headline thesis + stats say exactly '1 lie'", () => {
    renderMoodplays();
    expect(screen.getByTestId(TEST_IDS.storyThesis).textContent).toBe(
      MOODPLAYS_STORY.thesis,
    );
    const stats = screen.getByTestId(TEST_IDS.storyStats).textContent ?? "";
    expect(stats).toBe("10 claims checked · 1 lie · Kiro fooled · fixed in 2 lines");
    expect(stats).toContain("1 lie");
  });

  it("step 1 quotes the 24h-detection comment at openingHoursParser.ts:51-53", () => {
    renderMoodplays();
    const step = screen.getByTestId(TEST_IDS.storyStep(1));
    expect(step.textContent).toContain("Check for 24 hours");
    expect(step.textContent).toContain("Open 24 hours, never closing");
    expect(step.textContent).toContain("openingHoursParser.ts:51-53");
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
