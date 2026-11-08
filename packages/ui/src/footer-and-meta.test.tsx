// @vitest-environment jsdom
/**
 * Tests for the page footer (shown at the bottom of every target) and the
 * social-share metadata (Open Graph / Twitter Card + og:image SVG).
 *
 *   - The footer carries the MIT licence + attribution with a GitHub link, the
 *     Kiroween disclaimer, the per-target credit line (from the shown report's
 *     story `credit`), and the "original repositories were never modified"
 *     promise.
 *   - The footer renders on EVERY target: both the writing-tracker and the
 *     MoodPlays reports, with each target's own credit line.
 *   - The site-meta constants build ABSOLUTE share URLs from the CloudFront
 *     base, and the og:image SVG is 1200x630 in the lantern style and embeds
 *     the product thesis.
 *
 * Credit strings are asserted against the REAL report stories
 * (src/real-report.ts, src/moodplays-report.ts) so a drifted or fabricated
 * credit would fail the test (report-data-fidelity).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { LanternReportView, ReportFooter, TEST_IDS } from "./index.js";
import { WRITING_TRACKER_REPORT, WRITING_TRACKER_STORY } from "./real-report.js";
import { MOODPLAYS_REPORT, MOODPLAYS_STORY } from "./moodplays-report.js";
import {
  SITE_BASE_URL,
  SITE_DESCRIPTION,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  absoluteUrl,
  buildOgImageSvg,
  wrapText,
} from "./site-meta.js";

afterEach(cleanup);

describe("ReportFooter", () => {
  it("shows the licence line with a GitHub source link", () => {
    render(<ReportFooter />);
    const footer = screen.getByTestId(TEST_IDS.footer);
    expect(footer.textContent).toContain("© 2026 ikenyal");
    expect(footer.textContent).toContain("spec-lantern is MIT licensed");
    const link = within(footer).getByRole("link", { name: "Source on GitHub" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/ikenyal/spec-lantern",
    );
  });

  it("shows the Kiroween disclaimer and the never-modified promise", () => {
    render(<ReportFooter />);
    const footer = screen.getByTestId(TEST_IDS.footer);
    expect(footer.textContent).toContain(
      "Built with Kiro for Kiroween 2026. Not affiliated with or endorsed by AWS or Kiro.",
    );
    expect(footer.textContent).toContain(
      "The original repositories were never modified; fixes were applied only to throwaway copies.",
    );
  });

  it("renders the per-target credit line when given one, and omits it otherwise", () => {
    const { rerender } = render(
      <ReportFooter credit="MoodPlays by Gargi Sahu (MIT)." />,
    );
    expect(screen.getByTestId(TEST_IDS.footerCredit).textContent).toBe(
      "MoodPlays by Gargi Sahu (MIT).",
    );
    rerender(<ReportFooter />);
    expect(screen.queryByTestId(TEST_IDS.footerCredit)).toBeNull();
  });
});

describe("the footer appears on every target with its own credit", () => {
  it("writing-tracker report shows the writing-tracker credit", () => {
    render(
      <LanternReportView
        report={WRITING_TRACKER_REPORT}
        story={WRITING_TRACKER_STORY}
      />,
    );
    const footer = screen.getByTestId(TEST_IDS.footer);
    expect(footer).toBeTruthy();
    expect(screen.getByTestId(TEST_IDS.footerCredit).textContent).toBe(
      WRITING_TRACKER_STORY.credit,
    );
    // The project attribution is always present.
    expect(footer.textContent).toContain("spec-lantern is MIT licensed");
  });

  it("MoodPlays report shows the MoodPlays credit", () => {
    render(
      <LanternReportView report={MOODPLAYS_REPORT} story={MOODPLAYS_STORY} />,
    );
    expect(screen.getByTestId(TEST_IDS.footerCredit).textContent).toBe(
      MOODPLAYS_STORY.credit,
    );
  });
});

describe("site-meta: social-share URLs and og:image", () => {
  it("builds absolute share URLs from the CloudFront base", () => {
    expect(SITE_BASE_URL).toBe("https://d2xayupxggkiqt.cloudfront.net/");
    expect(absoluteUrl(OG_IMAGE_PATH)).toBe(
      "https://d2xayupxggkiqt.cloudfront.net/og-image.png",
    );
    // A leading slash on the path never produces a double slash.
    expect(absoluteUrl("/og-image.png")).toBe(
      "https://d2xayupxggkiqt.cloudfront.net/og-image.png",
    );
  });

  it("og:image SVG is 1200x630, dark, amber, and carries the thesis", () => {
    const svg = buildOgImageSvg();
    expect(svg).toContain(`width="${OG_IMAGE_WIDTH}"`);
    expect(svg).toContain(`height="${OG_IMAGE_HEIGHT}"`);
    // Lantern style: charcoal background + amber accent.
    expect(svg).toContain("#15171a");
    expect(svg).toContain("#ffb347");
    // The thesis is present (wrapped across tspans), checked by its opening
    // and closing fragments.
    expect(svg).toContain("AI-built apps are full of comments");
    expect(svg).toContain("proves.");
  });

  it("the description is the product thesis", () => {
    expect(SITE_DESCRIPTION).toContain("spec-lantern makes Kiro predict");
  });

  it("wrapText splits on spaces within the char budget and caps lines", () => {
    const lines = wrapText("one two three four five", 9, 3);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines.slice(0, -1)) {
      expect(line.length).toBeLessThanOrEqual(9);
    }
    // No words are dropped.
    expect(lines.join(" ").split(/\s+/)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
    ]);
  });
});

// --------------------------------------------------------------------------
// Mobile (375px) overflow-containment contract.
//
// jsdom performs no layout, so a true "nothing overflows at 375px" assertion
// needs a real browser (not available here). Instead we assert the CSS carries
// the narrow-viewport rules that keep wide content (the fix diff, raw JSON,
// evidence lines, long URLs, the month mock) scrolling/wrapping INSIDE its own
// container rather than widening the page, plus the global box-sizing:border-box
// the containment relies on. The manual 375px check is recorded in
// docs/mobile-375-check.md.
// --------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("mobile overflow-containment CSS contract (375px)", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "lantern-theme.css"),
    "utf8",
  );

  it("sets box-sizing:border-box globally so padding never widens the page", () => {
    expect(css).toMatch(/\*\s*\{[^}]*box-sizing:\s*border-box/);
  });

  it("has a narrow-viewport media query covering the 375px phone width", () => {
    expect(css).toContain("@media (max-width: 420px)");
  });

  it("keeps the fix diff and raw JSON scrolling inside their own box", () => {
    // The diff / raw value blocks carry overflow-x inside the narrow query.
    const narrow = css.slice(css.indexOf("@media (max-width: 420px)"));
    expect(narrow).toContain(".lantern-story__diff");
    expect(narrow).toContain("overflow-x: auto");
    expect(narrow).toContain(".lantern-raw__value");
  });

  it("lets flex children shrink (min-width:0) and wraps long URLs", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 420px)"));
    expect(narrow).toContain("min-width: 0");
    expect(narrow).toContain("overflow-wrap: anywhere");
  });
});
