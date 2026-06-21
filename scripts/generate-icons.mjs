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
//  2. The mark is Readmo's: an indigo (#3a4ec4) rounded-square tile, a
//     white reading/feed glyph (an open page with text lines) biased
//     toward the TOP, and a white "home-indicator pill" near the bottom
//     edge — the mobile-first motif inherited from newshacker.
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

// Readmo accent indigo (--rm-accent) and the white used for glyph + pill.
const INDIGO = '#3a4ec4';
const WHITE = '#ffffff';

// The reading glyph: an open page/book with text lines, biased toward the
// top of the tile. Drawn as a group so the maskable variant can reuse it
// at a smaller scale inside the safe zone. `cx`/`cy` center the group;
// `s` scales it. Coordinates are authored around a 0,0 origin then
// translated, so the glyph is easy to reposition between variants.
function readingGlyph({ cx, cy, s }) {
  // Page outline: a rounded rectangle with a soft center "spine" fold,
  // suggesting an open book / page. Text lines sit on the right leaf.
  // Authored in a roughly 200-wide x 150-tall box centered on origin.
  const t = `translate(${cx} ${cy}) scale(${s})`;
  return `
  <g transform="${t}" fill="none" stroke="${WHITE}" stroke-width="14"
     stroke-linecap="round" stroke-linejoin="round">
    <!-- open page outline -->
    <path d="M -95 -64 H 95 V 64 H -95 Z"/>
    <!-- center spine fold -->
    <path d="M 0 -64 V 64"/>
    <!-- text lines on the left leaf -->
    <path d="M -74 -30 H -22"/>
    <path d="M -74 0 H -22"/>
    <path d="M -74 30 H -36"/>
    <!-- text lines on the right leaf -->
    <path d="M 22 -30 H 74"/>
    <path d="M 22 0 H 74"/>
    <path d="M 22 30 H 60"/>
  </g>`;
}

// Non-maskable mark: rounded-square tile, glyph biased toward the top
// (centered above the midline), home-indicator pill near the bottom edge.
const FAVICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Readmo mark. Indigo rounded-square tile, a white open-page reading
     glyph biased toward the TOP, and a white home-indicator pill near the
     bottom edge (the iOS home indicator / Android gesture bar — a
     mobile-first cue readers see daily, inherited from newshacker). The
     pill survives as a horizontal stroke at favicon scale and is plainly
     visible at 192/512. Rasterized into public/icon-*.png by
     scripts/generate-icons.mjs. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="96" fill="${INDIGO}"/>
${readingGlyph({ cx: 256, cy: 212, s: 1.0 })}
  <rect x="176" y="404" width="160" height="14" rx="7" fill="${WHITE}"/>
</svg>`;

// Maskable variant: full-bleed tile (no rounded corners — the launcher
// applies its own shape mask; exposed transparent pixels would read as a
// chipped corner), glyph + pill pulled inside the 80% safe zone (a circle
// of radius ~205 centered on 256,256) so the most aggressive OEM crops
// can't nibble them.
const FAVICON_MASKABLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Android adaptive-icon / PWA maskable variant of public/favicon.svg.
     Differences from the non-maskable source:
      - Full-bleed indigo tile, no rounded corners (the OS launcher masks
        its own shape; transparent corners would read as chipped).
      - Glyph and home-indicator pill pulled inside the 80% safe zone
        (circle of radius ~205 px centered on 256,256): the glyph is
        scaled to ~0.78 and the pill shortened to 128x12 at y=384.
     Rasterized into public/icon-512-maskable.png by
     scripts/generate-icons.mjs. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${INDIGO}"/>
${readingGlyph({ cx: 256, cy: 222, s: 0.78 })}
  <rect x="192" y="384" width="128" height="12" rx="6" fill="${WHITE}"/>
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
