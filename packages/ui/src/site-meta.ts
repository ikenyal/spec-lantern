/**
 * Shared site metadata for social sharing (Open Graph / Twitter Card) and the
 * build-time og:image.
 *
 * This is the SINGLE source of truth for the absolute site base URL, the share
 * title/description (the product thesis), and the og:image path, so the HTML
 * `<meta>` tags, the og:image SVG, and any test all read the same values and
 * cannot drift apart. The SVG template here is rendered to a 1200x630 PNG at
 * build time by `scripts/generate-og-image.ts` — NOT shipped as raw SVG — so a
 * scraper that only accepts raster og:images still gets a preview.
 *
 * The values are static project metadata (not pipeline output), so this module
 * invents no report data; it is safe for both the library build and the demo.
 */

/**
 * The absolute base URL of the Hosted_Demo (CloudFront default domain, per the
 * hosted-demo-aws constraint). Open Graph requires ABSOLUTE URLs, so every
 * share URL below is built from this. Keep the trailing slash so `join`-style
 * concatenation of a root-relative path yields a clean absolute URL.
 */
export const SITE_BASE_URL = "https://d2xayupxggkiqt.cloudfront.net/";

/** The share title shown in link previews. */
export const SITE_TITLE = "spec-lantern · the comments are lying";

/**
 * The share description — the PRODUCT thesis, identical to the one the report
 * headlines (src/real-report.ts WRITING_TRACKER_STORY.thesis). Kept in sync by
 * hand on purpose: this module is import-safe for the HTML head (no React), and
 * the thesis is short and stable.
 */
export const SITE_DESCRIPTION =
  "AI-built apps are full of comments that lie — and AI reviewers believe them. " +
  "spec-lantern makes Kiro predict, then executes, then proves.";

/** Root-relative path of the generated og:image PNG (written under public/). */
export const OG_IMAGE_PATH = "og-image.png";

/** Theme colour for the browser UI (the lantern amber). */
export const THEME_COLOR = "#ffb347";

/** The og:image dimensions Open Graph recommends (1.91:1). */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** Resolve a root-relative path to an absolute URL against {@link SITE_BASE_URL}. */
export function absoluteUrl(pathRelativeToRoot: string): string {
  // SITE_BASE_URL ends with "/"; strip any leading "/" on the path so we never
  // produce a double slash.
  return SITE_BASE_URL + pathRelativeToRoot.replace(/^\/+/, "");
}

/**
 * Escape a string for safe inclusion in XML/SVG text content.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Word-wrap a sentence into at most `maxLines` lines of at most `maxChars`
 * characters each, breaking on spaces. A line that would exceed `maxChars`
 * starts a new line; the last allowed line absorbs the remainder. Pure and
 * deterministic so the og:image renders identically every build.
 */
export function wrapText(
  text: string,
  maxChars: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) {
        // Last line: take the rest verbatim.
        current = [word, ...words.slice(words.indexOf(word) + 1)].join(" ");
        break;
      }
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

/**
 * Build the og:image SVG in the lantern style: a dark charcoal background, an
 * amber lantern glyph, and the product thesis set in large type. Rendered to a
 * 1200x630 PNG at build time. Colours mirror the lantern theme
 * (src/lantern-theme.css).
 *
 * The lantern is drawn from simple primitives (a glowing flame, a glass body,
 * a cap and ring) rather than an emoji, so it rasterizes crisply at any size
 * and needs no font with emoji coverage.
 */
export function buildOgImageSvg(
  thesis: string = SITE_DESCRIPTION,
): string {
  const W = OG_IMAGE_WIDTH;
  const H = OG_IMAGE_HEIGHT;
  // Wrap the thesis to fit the right-hand text column.
  const lines = wrapText(thesis, 34, 5);
  const fontSize = 46;
  const lineHeight = 60;
  const textBlockHeight = lines.length * lineHeight;
  const textStartY = H / 2 - textBlockHeight / 2 + fontSize;
  const textX = 430;

  const tspans = lines
    .map((line, i) => {
      const dy = i === 0 ? 0 : lineHeight;
      return `<tspan x="${textX}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");

  // Lantern centred in the left column.
  const lx = 215;
  const ly = H / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="42%" r="60%">
      <stop offset="0%" stop-color="#ffb347" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffb347" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="flame" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffe29a"/>
      <stop offset="100%" stop-color="#ffb347"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#15171a"/>
  <circle cx="${lx}" cy="${ly}" r="230" fill="url(#glow)"/>
  <g transform="translate(${lx}, ${ly})">
    <!-- top ring + cap -->
    <rect x="-8" y="-160" width="16" height="22" rx="4" fill="#2c3036"/>
    <path d="M -58 -130 L 58 -130 L 40 -108 L -40 -108 Z" fill="#2c3036"/>
    <!-- glass body -->
    <path d="M -50 -108 L 50 -108 L 62 108 L -62 108 Z" fill="#1e2125" stroke="#ffb347" stroke-width="5"/>
    <!-- flame -->
    <path d="M 0 -70 C 34 -34 34 24 0 60 C -34 24 -34 -34 0 -70 Z" fill="url(#flame)"/>
    <circle cx="0" cy="18" r="22" fill="#ffe29a"/>
    <!-- base -->
    <rect x="-70" y="108" width="140" height="22" rx="6" fill="#2c3036"/>
  </g>
  <text x="${textX}" y="${textStartY}" fill="#e8eaed" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="-0.5">${tspans}</text>
  <text x="${textX}" y="${H - 60}" fill="#ffb347" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" letter-spacing="2">SPEC-LANTERN</text>
</svg>`;
}
