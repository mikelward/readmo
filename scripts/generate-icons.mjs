// Generate Readmo's full icon set into public/ from inline SVG strings.
// Run manually whenever the mark changes:
//
//   node scripts/generate-icons.mjs      (or: npm run icons:generate)
//
// Adapted from newshacker's scripts/generate-icons.mjs. Two differences:
//  1. The SVG source lives here as inline strings (the single source of
//     truth for the mark) — the script writes public/favicon.svg and
//     public/favicon-maskable.svg itself, then rasterizes the PNGs from
//     those same strings. No hand-maintained SVG to drift out of sync.
//  2. The mark is Readmo's: a charcoal ink (#363636) rounded-square tile, a
//     paper-white uppercase "R" centered slightly above the midline, and
//     a paper-white "home-indicator pill" near the bottom edge — the
//     letter-mark + mobile-first motif inherited from newshacker, in our
//     ink-on-paper palette.
//
// Uses the repo's direct `sharp` devDependency. It's a dev-time one-shot:
// writes into public/, and the produced PNGs/SVGs are committed alongside
// any mark change. Re-rasterizing on every build would be wasted CI time
// for files that rarely move, so this stays a manual script, not a build
// step.

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');

// sharp hands the SVG to librsvg, which renders at 72 DPI by default. At
// that density a 512-target SVG rasterizes to a small intermediate bitmap
// that's then upscaled — edges go soft. Bumping the input density makes
// the intermediate bitmap large enough that the downscale to any target
// stays crisp for the largest (512x512). Higher is wasted work.
const INPUT_DENSITY = 384;

// Paper / monochrome mark: a charcoal ink tile with a paper-white
// letterform and home-indicator pill, matching the "ink on paper" theme.
// Matches the default Ink palette's --rm-brand-tile (#363636).
const INK = '#363636';
const PAPER = '#faf9f5';

const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

// Non-maskable mark: rounded-square ink tile, uppercase "R" centered
// slightly above the midline, home-indicator pill near the bottom edge.
const FAVICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Readmo mark. Ink rounded-square tile, a paper-white uppercase "R"
     centered slightly above the midline, and a paper-white home-indicator
     pill near the bottom edge (the iOS home indicator / Android gesture
     bar — a mobile-first cue readers see daily, inherited from
     newshacker). The pill survives as a horizontal stroke at favicon
     scale and is plainly visible at 192/512. Rasterized into
     public/icon-*.png by scripts/generate-icons.mjs. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="96" fill="${INK}"/>
  <text x="256" y="240"
        text-anchor="middle"
        dominant-baseline="central"
        font-family="${FONT_FAMILY}"
        font-weight="700"
        font-size="320"
        fill="${PAPER}">R</text>
  <rect x="176" y="400" width="160" height="12" rx="6" fill="${PAPER}"/>
</svg>`;

// Maskable variant: full-bleed tile (no rounded corners — the launcher
// applies its own shape mask; exposed transparent pixels would read as a
// chipped corner), glyph + pill pulled inside the 80% safe zone (a circle
// of radius ~205 centered on 256,256) so the most aggressive OEM crops
// can't nibble them.
const FAVICON_MASKABLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Android adaptive-icon / PWA maskable variant of public/favicon.svg.
     Differences from the non-maskable source:
      - Full-bleed ink tile, no rounded corners (the OS launcher masks its
        own shape; transparent corners would read as chipped).
      - Glyph and home-indicator pill pulled inside the 80% safe zone
        (circle of radius ~205 px centered on 256,256): the "R" is sized
        down to 256 and the pill shortened to 128x10 at y=380.
     Rasterized into public/icon-512-maskable.png by
     scripts/generate-icons.mjs. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${INK}"/>
  <text x="256" y="240"
        text-anchor="middle"
        dominant-baseline="central"
        font-family="${FONT_FAMILY}"
        font-weight="700"
        font-size="256"
        fill="${PAPER}">R</text>
  <rect x="192" y="380" width="128" height="10" rx="5" fill="${PAPER}"/>
</svg>`;

// SVG files written to public/, plus the PNG raster targets and which SVG
// each rasterizes from.
const SVG_FILES = [
  { name: 'favicon.svg', svg: FAVICON_SVG },
  { name: 'favicon-maskable.svg', svg: FAVICON_MASKABLE_SVG },
];

const PNG_TARGETS = [
  { name: 'favicon-32.png', size: 32, svg: FAVICON_SVG },
  { name: 'apple-touch-icon.png', size: 180, svg: FAVICON_SVG },
  { name: 'icon-192.png', size: 192, svg: FAVICON_SVG },
  { name: 'icon-512.png', size: 512, svg: FAVICON_SVG },
  { name: 'icon-512-maskable.png', size: 512, svg: FAVICON_MASKABLE_SVG },
];

async function main() {
  await mkdir(publicDir, { recursive: true });

  for (const { name, svg } of SVG_FILES) {
    await writeFile(resolve(publicDir, name), `${svg}\n`, 'utf8');
    console.log(`wrote ${name}`);
  }

  for (const { name, size, svg } of PNG_TARGETS) {
    const out = resolve(publicDir, name);
    await sharp(Buffer.from(svg), { density: INPUT_DENSITY })
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(`wrote ${name} (${size}x${size})`);
  }
}

await main();
