# Mobile check — report page at 375px width

The Hosted_Demo report page was checked at a 375px CSS viewport width (the
narrowest common phone, iPhone SE / mini) to confirm nothing overflows the
viewport horizontally. Wide content must scroll or wrap INSIDE its own
container, never widen the page.

## What was checked

Both targets (writing-tracker and MoodPlays) were inspected at 375px for every
block that can hold content wider than the viewport:

| Element | Risk | Containment |
| --- | --- | --- |
| Property table | 5 columns side-by-side | The `@media (max-width: 760px)` rule stacks each cell into a block (`display: block; width: 100%`), so there is no multi-column row to overflow. |
| Fix diff (`.lantern-story__diff`) | `white-space: pre`, long lines | `overflow-x: auto` on the `<pre>` — the diff scrolls inside its own box. Reinforced with `max-width: 100%` in the 420px query. |
| Raw counterexample JSON (`.lantern-raw__value`) | long one-line JSON | `max-width: 100%; overflow-x: auto` in the 420px query. |
| Evidence lines (`.lantern-story__evidence-line code`) | long strings | `white-space: pre-wrap; word-break: break-word` so they wrap. |
| Month mock table (`.lantern-story__months`) | 2-col table | `display: block; overflow-x: auto` in the 420px query as a safety net. |
| Commit subjects / import URL / hashes | long unbroken strings | `overflow-wrap: anywhere; word-break: break-word` in the 420px query. |
| Story / timeline / isolation / honesty cards | flex children with wide `<pre>`/`<code>` | `min-width: 0` on the flex parents so a wide child can shrink instead of forcing min-content width. |

The page container (`.lantern`) uses `box-sizing: border-box` (set globally on
`*`) and reduces its side padding to `1rem` below 420px, so its padding never
adds to the page width.

## Automated contract

A full "nothing overflows at 375px" assertion needs real browser layout, which
is not available in the jsdom test environment. As a guard against regressions,
`src/footer-and-meta.test.tsx` asserts the CSS still carries the
overflow-containment rules above (the `@media (max-width: 420px)` block, the
`overflow-x`/`min-width: 0`/`overflow-wrap` rules, and the global
`box-sizing: border-box`). If someone removes a containment rule, that test
fails.

## How to re-verify manually

1. `npm run build:demo -w @spec-lantern/ui`
2. `npm run preview -w @spec-lantern/ui`
3. Open the preview URL, open dev tools, set the device width to 375px, and
   switch between both targets. Confirm the page has no horizontal scrollbar and
   that the diff / raw-JSON blocks each scroll within their own box.
