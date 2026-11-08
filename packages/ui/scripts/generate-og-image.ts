/**
 * Build-time CLI that renders the social-share og:image to a 1200x630 PNG.
 *
 * Run with `npm run generate:og -w @spec-lantern/ui` (invoked by `build:demo`
 * before the Vite build). It builds the lantern-style SVG from the shared
 * {@link ../src/site-meta.ts} template (dark background, amber lantern, the
 * product thesis), rasterizes it to PNG with `@resvg/resvg-js`, and writes it to
 * `public/og-image.png`. Vite copies `public/` verbatim into the built site, so
 * the PNG is reachable at the absolute og:image URL the HTML `<meta>` tags
 * point at.
 *
 * It renders a PNG (not raw SVG) because many social scrapers only accept
 * raster og:images. Nothing here is report data — it is static share metadata.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import {
  buildOgImageSvg,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
} from "../src/site-meta.js";

async function main(): Promise<void> {
  const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outFile = join(uiRoot, "public", OG_IMAGE_PATH);
  await mkdir(dirname(outFile), { recursive: true });

  const svg = buildOgImageSvg();
  const resvg = new Resvg(svg, {
    // Render at the target pixel width so the output is exactly 1200x630.
    fitTo: { mode: "width", value: OG_IMAGE_WIDTH },
    background: "#15171a",
  });
  const png = resvg.render().asPng();
  await writeFile(outFile, png);
  console.log(`generated /${OG_IMAGE_PATH} (${png.length} bytes)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
