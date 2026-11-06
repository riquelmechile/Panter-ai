# Brand generators

Every image in `docs/assets` except the mascot comes from these scripts. To change a text, edit it in the generator and rebuild. Editing the SVGs by hand works only until the next rebuild.

| Script | Writes | Motion |
|---|---|---|
| `gen-hero.mjs` | `panter-hero(.es).svg` | Aurora light drifting on 11, 13 and 17 s loops, the connector at the end of the mascot's tail pulsing, and an underline that draws itself once |
| `gen-typing.mjs` | `panter-typing(.es).svg` | A terminal that types, holds and erases each line, with a cursor that follows the exact width of each glyph |
| `gen-diagrams.py` | the five diagrams, `*.svg` and `*.es.svg` | A work packet travels each diagram's path |

## Rules the output follows

- **Pure SVG.** GitHub runs SMIL and CSS `@keyframes` inside an SVG shown as an image. It never runs scripts and never loads external fonts or images. The hero and the terminal convert their text to vector paths, so they look the same on every machine. The diagrams use the reader's system fonts.
- **Dark and light themes in one file,** through `@media (prefers-color-scheme: light)`.
- **Reduced motion.** In Chrome, SMIL outranks CSS, so a CSS rule cannot stop an animation. Each animated part sits in a group of class `motion` or `pkt`, which `@media (prefers-reduced-motion: reduce)` hides with `display: none`. A `still` group shows a static frame instead. `tests/brand-assets.test.ts` checks this.
- **Discrete SMIL timing.** With `calcMode="discrete"` the last value never applies, so a "visible between A and B" window is written `values="0;1;0;0" keyTimes="0;A;B;1"`. Repeated `keyTimes` values invalidate the whole animation, which is why the terminal waits 0.4 s before its first keystroke.

## Rebuild

Run these from this folder. You need Node 20 or later and Python 3.

```sh
npm install
mkdir -p fonts
curl -fL -o fonts/JetBrainsMono-Bold.ttf \
  https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/ttf/JetBrainsMono-Bold.ttf
sh build.sh
```

Then run `npm test` from the repository root.

The fonts are under the SIL Open Font License 1.1 and are not committed. Space Grotesk comes from `@fontsource/space-grotesk`. JetBrains Mono has to be the full TTF, because the fontsource subsets lack `→` and `✓`.

To look at real frames in Chrome (Playwright and Pillow required):

```sh
python3 verify-frames.py "$PWD/../../docs/assets/panter-hero.svg" /tmp/hero 0.5,3,8 dark 1200 380
```

Open the SVG directly to check reduced motion. Chrome's reduced-motion emulation does not reach an SVG loaded through an `<img>` tag.
