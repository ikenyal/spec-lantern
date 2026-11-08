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
      steps: [
        {
          phase: "predictions-locked",
          label: "Predictions locked",
          at: "2026-11-03T05:21:22.398Z",
          detail: "lock hash 0fcb9d687dd6",
        },
        {
          phase: "lock-commit",
          label: "Lock committed to git",
          at: "2026-11-03T14:23:15+09:00",
          commit: "00191a6",
          commitSubject: "stage B: locked predictions",
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
          at: "2026-11-03T07:04:03.235Z",
          commit: "85e1e76",
          commitSubject: "stage E",
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
      steps: [
        {
          phase: "predictions-locked",
          label: "Predictions locked",
          at: "2026-11-07T20:54:49.854Z",
          detail: "lock hash bd00527b86a1",
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
      "predictions-locked",
      "lock-commit",
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

  it("shows the 'predictions locked before execution' callout from the computed flag", () => {
    render(<ReportSections sections={SECTIONS} targetId="writing-tracker" />);
    const callout = screen.getByTestId(TEST_IDS.timelineLockedBefore);
    expect(callout.textContent).toMatch(/before/i);
  });

  it("selects the timeline by target id (MoodPlays)", () => {
    render(<ReportSections sections={SECTIONS} targetId="moodplays" />);
    const heading = screen.getByRole("heading", { name: /MoodPlays/ });
    expect(heading).toBeTruthy();
  });

  it("renders each timestamp as a machine-readable <time>", () => {
    const { container } = render(
      <ReportSections sections={SECTIONS} targetId="writing-tracker" />,
    );
    const times = container.querySelectorAll("time[datetime]");
    expect(times.length).toBeGreaterThan(0);
    expect(times[0].getAttribute("datetime")).toBe("2026-11-03T05:21:22.398Z");
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
