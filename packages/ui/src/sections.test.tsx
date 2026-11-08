// @vitest-environment jsdom
/**
 * Tests for the three report sections rendered below the story and above the
 * table: "Behind the lantern" (per-target timeline), "How it stays safe"
 * (two-phase isolation), and "We hold ourselves to the same standard".
 *
 * These assert the UI CONTRACT: the timeline links commit short hashes to the
 * right GitHub URL, surfaces the "predictions locked before execution" callout
 * from the computed flag, selects the timeline by target id, and that the
 * isolation + honesty sections render their data with self-describing links and
 * accessible structure. The data here is a typed fixture (the generator's
 * output is tested separately in generate-timeline.test.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import {
  LanternReportView,
  ReportSections,
  TEST_IDS,
} from "./index.js";
import {
  GITHUB_COMMIT_BASE,
  formatUtc,
  type ReportSectionsAsset,
} from "./report-asset.js";
import type { LanternReport } from "@spec-lantern/types";

afterEach(cleanup);

const SECTIONS: ReportSectionsAsset = {
  generatedAt: "2026-01-04T00:00:00.000Z",
  commitBase: GITHUB_COMMIT_BASE,
  timelines: [
    {
      id: "writing-tracker",
      label: "writing-tracker",
      predictionsLockedBeforeExecution: true,
      verdictMismatches: [],
      harnessRevisions: {
        count: 2,
        timing: "after-first-run",
        timingNote:
          "a first run exposed harness defects, which were then revised and re-locked with the verdicts unchanged",
        readmePath:
          "packages/mcp-server/skeleton/writing-tracker-full/locks/superseded/README.md",
      },
      steps: [
        {
          phase: "predictions-first-locked",
          label: "Predictions first locked",
          at: "2026-11-03T05:21:22.398Z",
          commit: "00191a6",
          commitSubject: "stage B: locked predictions",
          detail: "lock hash 0fcb9d687dd6",
        },
        {
          phase: "final-locks",
          label: "Final locks",
          at: "2026-11-03T05:35:18.368Z",
          commit: "be4c190",
          commitSubject: "stage C: harness revision re-lock",
        },
        {
          phase: "execution",
          label: "Executed in the isolated runner",
          at: "2026-11-03T05:43:03.535Z",
          commit: "5770a09",
          commitSubject: "stage C",
        },
        {
          phase: "replay-reproduced",
          label: "Counterexample replayed",
          at: "2026-11-03T05:43:38.285Z",
          detail: "same failure reproduced (reproducesSameFail: true)",
        },
        {
          phase: "fix",
          label: "Fix applied to a throwaway copy",
          at: "2026-11-03T05:51:28.835Z",
          commit: "825fed9",
          commitSubject: "stage D: fix on copy",
        },
        {
          phase: "regression-check",
          label: "All properties re-run (regression check)",
          at: "2026-11-03T07:04:03.235Z",
          commit: "85e1e76",
          commitSubject: "stage E",
        },
      ],
    },
    {
      id: "moodplays",
      label: "MoodPlays",
      predictionsLockedBeforeExecution: true,
      verdictMismatches: [],
      harnessRevisions: {
        count: 5,
        timing: "before-any-execution",
        timingNote:
          "all 5 restated the implementation and were rewritten with independent oracles before any execution",
        readmePath:
          "packages/mcp-server/skeleton/moodplays/locks/superseded/README.md",
      },
      steps: [
        {
          phase: "predictions-first-locked",
          label: "Predictions first locked",
          at: "2026-11-07T20:54:49.854Z",
          commit: "69e28e5",
          commitSubject: "mp stage B: locked",
          detail: "lock hash bd00527b86a1",
        },
        {
          phase: "final-locks",
          label: "Final locks",
          at: "2026-11-07T21:27:00.235Z",
          commit: "d81cf0a",
          commitSubject: "mp stage B: re-lock props 2,10",
        },
        {
          phase: "execution",
          label: "Executed in the isolated runner",
          at: "2026-11-07T21:37:48.797Z",
          commit: "7046fca",
          commitSubject: "mp stage C",
        },
      ],
    },
  ],
  isolation: {
    phases: [
      {
        id: "install",
        title: "Install phase",
        summary: "internal-only network",
        guarantees: [
          { text: "install on an --internal network", source: "install-phase.ts" },
          { text: "--ignore-scripts", source: "install-phase.ts" },
        ],
      },
      {
        id: "test",
        title: "Test phase",
        summary: "no network",
        guarantees: [
          { text: "--network none", source: "test-phase.ts" },
        ],
      },
    ],
    crossCutting: [
      { text: "Safety Gate refuses host fallback", source: "safety-gate/index.ts" },
      { text: "fixes touch only a throwaway copy", source: "revive/apply-fixes.ts" },
    ],
  },
  honesty: [
    {
      title: "Our own Safety Gate had a bypass",
      body: "property test caught it",
      linkLabel: "70d61ad",
      href: `${GITHUB_COMMIT_BASE}70d61ad`,
    },
    {
      title: "writing-tracker harness defects",
      body: "not reported as bugs",
      linkLabel: "writing-tracker-full/locks/superseded/README.md",
      href: "packages/mcp-server/skeleton/writing-tracker-full/locks/superseded/README.md",
    },
  ],
};

describe("ReportSections — Behind the lantern (timeline)", () => {
  it("renders the timeline for the selected target and links commits to GitHub", () => {
    render(<ReportSections sections={SECTIONS} targetId="writing-tracker" />);
    const timeline = screen.getByTestId(TEST_IDS.timeline);
    // The six phases render in order.
    for (const phase of [
      "predictions-first-locked",
      "final-locks",
      "execution",
      "replay-reproduced",
      "fix",
      "regression-check",
    ]) {
      expect(screen.getByTestId(TEST_IDS.timelineStep(phase))).toBeTruthy();
    }
    // Commit short hash links to the canonical GitHub commit URL.
    const lockCommitLink = within(timeline).getByRole("link", {
      name: /00191a6/,
    });
    expect(lockCommitLink.getAttribute("href")).toBe(
      `${GITHUB_COMMIT_BASE}00191a6`,
    );
  });

  it("shows both the first-lock and the final-lock steps with their own commits", () => {
    render(<ReportSections sections={SECTIONS} targetId="writing-tracker" />);
    const first = screen.getByTestId(
      TEST_IDS.timelineStep("predictions-first-locked"),
    );
    const final = screen.getByTestId(TEST_IDS.timelineStep("final-locks"));
    // First lock: earliest lockedAt + the commit that first added locks.
    expect(first.textContent).toMatch(/Predictions first locked/);
    expect(within(first).getByRole("link").getAttribute("href")).toBe(
      `${GITHUB_COMMIT_BASE}00191a6`,
    );
    // Final locks: latest active lockedAt + the commit that last changed locks/.
    expect(final.textContent).toMatch(/Final locks/);
    expect(within(final).getByRole("link").getAttribute("href")).toBe(
      `${GITHUB_COMMIT_BASE}be4c190`,
    );
  });

  it("points the fix step and the regression step to DIFFERENT commits", () => {
    render(<ReportSections sections={SECTIONS} targetId="writing-tracker" />);
    const fix = screen.getByTestId(TEST_IDS.timelineStep("fix"));
    const regression = screen.getByTestId(
      TEST_IDS.timelineStep("regression-check"),
    );
    expect(within(fix).getByRole("link").getAttribute("href")).toBe(
      `${GITHUB_COMMIT_BASE}825fed9`,
    );
    expect(within(regression).getByRole("link").getAttribute("href")).toBe(
      `${GITHUB_COMMIT_BASE}85e1e76`,
    );
  });

  it("states the prediction-lock claim and the harness revisions SEPARATELY", () => {
    render(<ReportSections sections={SECTIONS} targetId="writing-tracker" />);
    // 1. Predicted verdicts locked before any execution (its own statement).
    const verdicts = screen.getByTestId(TEST_IDS.timelineVerdictsLocked);
    expect(verdicts.textContent).toMatch(
      /All predicted verdicts were locked before any execution/i,
    );
    // 2. Harness revisions are a DISTINCT statement, with count + timing + link.
    const harness = screen.getByTestId(TEST_IDS.timelineHarnessRevisions);
    expect(harness.textContent).toMatch(/2 test harnesses were revised/i);
    expect(harness.textContent).toMatch(/verdicts unchanged/i);
    expect(harness.textContent).toMatch(/a first run exposed harness defects/i);
    const readmeLink = within(harness).getByRole("link");
    expect(readmeLink.getAttribute("href")).toMatch(
      /github\.com\/ikenyal\/spec-lantern\/blob\/main\/.*superseded\/README\.md/,
    );
  });

  it("states the MoodPlays harness revisions happened before any execution", () => {
    render(<ReportSections sections={SECTIONS} targetId="moodplays" />);
    const harness = screen.getByTestId(TEST_IDS.timelineHarnessRevisions);
    expect(harness.textContent).toMatch(/5 test harnesses were revised/i);
    expect(harness.textContent).toMatch(/before any execution/i);
  });

  it("flags a verdict mismatch between a superseded and active lock", () => {
    const withMismatch: ReportSectionsAsset = {
      ...SECTIONS,
      timelines: [
        {
          ...SECTIONS.timelines[0],
          verdictMismatches: [
            {
              propertyId: "property-2",
              activeVerdict: "PASS",
              supersededVerdict: "FAIL",
            },
          ],
        },
      ],
    };
    render(<ReportSections sections={withMismatch} targetId="writing-tracker" />);
    const flag = screen.getByTestId(TEST_IDS.timelineVerdictMismatch);
    expect(flag.getAttribute("role")).toBe("alert");
    expect(flag.textContent).toMatch(/property-2/);
    expect(flag.textContent).toMatch(/active PASS/);
    expect(flag.textContent).toMatch(/superseded FAIL/);
  });

  it("shows a warning statement when not every verdict was locked before execution", () => {
    const notLocked: ReportSectionsAsset = {
      ...SECTIONS,
      timelines: [
        { ...SECTIONS.timelines[0], predictionsLockedBeforeExecution: false },
      ],
    };
    render(<ReportSections sections={notLocked} targetId="writing-tracker" />);
    const verdicts = screen.getByTestId(TEST_IDS.timelineVerdictsLocked);
    expect(verdicts.textContent).toMatch(
      /Not every predicted verdict was locked before execution/i,
    );
  });

  it("selects the timeline by target id (MoodPlays)", () => {
    render(<ReportSections sections={SECTIONS} targetId="moodplays" />);
    const heading = screen.getByRole("heading", { name: /MoodPlays/ });
    expect(heading).toBeTruthy();
  });

  it("keeps the raw value in datetime but displays every time normalized to UTC", () => {
    const { container } = render(
      <ReportSections sections={SECTIONS} targetId="writing-tracker" />,
    );
    const times = Array.from(container.querySelectorAll("time[datetime]"));
    expect(times.length).toBeGreaterThan(0);
    // The first step's raw value is preserved in the datetime attribute …
    expect(times[0].getAttribute("datetime")).toBe("2026-11-03T05:21:22.398Z");
    // … while the DISPLAYED text is normalized to one UTC format.
    expect(times[0].textContent).toBe("2026-11-03 05:21:22 UTC");
    // Every displayed time ends in "UTC" so the steps read in order at a glance.
    for (const t of times) {
      expect(t.textContent).toMatch(/ UTC$/);
    }
  });
});

describe("formatUtc", () => {
  it("normalizes a UTC Z timestamp", () => {
    expect(formatUtc("2026-11-03T05:21:22.398Z")).toBe("2026-11-03 05:21:22 UTC");
  });

  it("converts a +09:00 offset to UTC so ordering reads correctly", () => {
    // 14:23:15 +09:00 is 05:23:15 UTC.
    expect(formatUtc("2026-11-03T14:23:15+09:00")).toBe(
      "2026-11-03 05:23:15 UTC",
    );
  });

  it("returns the input unchanged for an unparseable value", () => {
    expect(formatUtc("not-a-date")).toBe("not-a-date");
  });
});

describe("ReportSections — How it stays safe (isolation)", () => {
  it("renders both phases and the cross-cutting guarantees", () => {
    render(<ReportSections sections={SECTIONS} targetId="writing-tracker" />);
    expect(screen.getByTestId(TEST_IDS.isolationPhase("install"))).toBeTruthy();
    expect(screen.getByTestId(TEST_IDS.isolationPhase("test"))).toBeTruthy();
    const iso = screen.getByTestId(TEST_IDS.isolation);
    expect(iso.textContent).toMatch(/--network none/);
    expect(iso.textContent).toMatch(/--ignore-scripts/);
    expect(iso.textContent).toMatch(/Safety Gate refuses host fallback/);
    expect(iso.textContent).toMatch(/throwaway copy/);
  });
});

describe("ReportSections — We hold ourselves to the same standard", () => {
  it("renders each item with a self-describing link (commit hash / file path)", () => {
    render(<ReportSections sections={SECTIONS} targetId="writing-tracker" />);
    const honesty = screen.getByTestId(TEST_IDS.honesty);
    const gateLink = within(honesty).getByRole("link", { name: "70d61ad" });
    expect(gateLink.getAttribute("href")).toBe(`${GITHUB_COMMIT_BASE}70d61ad`);
    // A repo-relative file path resolves to a GitHub blob link.
    const fileLink = within(honesty).getByRole("link", {
      name: /superseded\/README\.md/,
    });
    expect(fileLink.getAttribute("href")).toMatch(
      /github\.com\/ikenyal\/spec-lantern\/blob\/main\//,
    );
  });
});

describe("LanternReportView wiring", () => {
  const REPORT: LanternReport = {
    comparisons: [],
    observedDeviations: [],
    noConfirmedBug: true,
    noObservedDeviation: true,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("renders the three sections between the story area and the table", () => {
    const { container } = render(
      <LanternReportView
        report={REPORT}
        sections={SECTIONS}
        targetId="writing-tracker"
      />,
    );
    const sections = screen.getByTestId(TEST_IDS.sections);
    const table = screen.getByTestId("property-table");
    expect(sections).toBeTruthy();
    // The sections block precedes the table in document order.
    // DOCUMENT_POSITION_FOLLOWING === 4; use the node's own constant to avoid a
    // bare `Node` global (jsdom env).
    const FOLLOWING = table.DOCUMENT_POSITION_FOLLOWING;
    expect(sections.compareDocumentPosition(table) & FOLLOWING).toBeTruthy();
    void container;
  });

  it("omits the sections when no asset is provided (layout unchanged)", () => {
    render(<LanternReportView report={REPORT} />);
    expect(screen.queryByTestId(TEST_IDS.sections)).toBeNull();
  });
});
