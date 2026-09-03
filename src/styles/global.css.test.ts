// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

function declarationsFor(selector: string): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Record<string, string> = {};
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(withoutComments))) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const [prop, ...rest] = decl.split(':');
      if (!prop.trim() || rest.length === 0) continue;
      out[prop.trim()] = rest.join(':').trim();
    }
  }
  return out;
}

/** Every value declared for `prop` on `selector`, in source order — a
 * progressive-enhancement pair (vh then dvh) declares it twice. */
function valuesFor(selector: string, prop: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(withoutComments))) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const [name, ...rest] = decl.split(':');
      if (name.trim() !== prop || rest.length === 0) continue;
      out.push(rest.join(':').trim());
    }
  }
  return out;
}

describe('page-level scrollbar gutter', () => {
  // Without this, the viewport width changes between short pages (no
  // scrollbar) and pages tall enough to scroll (scrollbar takes ~15px), and
  // the layout shifts horizontally on every navigation that crosses the
  // threshold.
  it('reserves a stable scrollbar gutter on <html>', () => {
    expect(declarationsFor('html')['scrollbar-gutter']).toBe('stable');
  });
});

// The page column every list view's bottom toolbar ultimately bottoms out in.
// Before it, a list container ended right under its content, so anything
// shorter than the screen — a refresh spinner, an empty result, three rows —
// left the bar hanging mid-page and jumped it down as rows arrived. See
// ListToolbar.css / ListToolbar.css.test.ts for the other half.
describe('main column reaches the foot of the screen', () => {
  it('lays the routed page out as a column', () => {
    const main = declarationsFor('.app-main');
    expect(main.display).toBe('flex');
    expect(main['flex-direction']).toBe('column');
  });

  it('floors it at the viewport minus the sticky header', () => {
    const heights = valuesFor('.app-main', 'min-height');
    // Both units, in that order: dvh (mobile dynamic toolbars) wins where it's
    // supported, vh is the fallback that has to come first.
    expect(heights).toHaveLength(2);
    expect(heights[0]).toContain('100vh');
    expect(heights[1]).toContain('100dvh');
    for (const height of heights) {
      // Only the header comes off. It's a border-box `height:
      // var(--rm-header-h)` that swallows its own safe-area-inset-top padding
      // (which is why `.list-toolbar--top` can pin at that flat value), and
      // `.app-main`'s own safe-area-inset-bottom padding is inside this
      // min-height for the same reason — so header + main is exactly one
      // viewport and a short page still has nothing to scroll. Subtracting
      // either inset again would leave the toolbar short of the fold.
      expect(height).toContain('var(--rm-header-h)');
      expect(height).not.toContain('env(safe-area-inset');
    }
  });

  it('keeps the bottom padding that clears the home indicator', () => {
    expect(declarationsFor('.app-main').padding).toContain(
      'env(safe-area-inset-bottom)',
    );
  });
});

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channel = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

interface Pairing {
  selector: string;
  text: string;
  card: string;
}

/** Every declaration block that sets both `--rm-text` and `--rm-bg-card` — one
 * per palette per mode. Discovered rather than listed by selector, so a new
 * palette is held to the same bounds the day it lands instead of the day
 * somebody remembers to add it here. */
function textOnCardPairings(): Pairing[] {
  const out: Pairing[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(cssNoComments))) {
    const text = /--rm-text:\s*(#[0-9a-f]{6})/i.exec(m[2])?.[1];
    const card = /--rm-bg-card:\s*(#[0-9a-f]{6})/i.exec(m[2])?.[1];
    if (!text || !card) continue;
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), text, card });
  }
  return out;
}

describe('global.css body-text contrast', () => {
  const pairings = textOnCardPairings();

  it('finds a text-on-card pairing for every palette and mode', () => {
    // The regexes above are the kind that go quietly green when the file moves
    // underneath them, so assert the parse found something first: two palettes
    // x (light, dark, system-dark) = six.
    expect(pairings.length).toBe(6);
  });

  it('clears AAA everywhere', () => {
    for (const { selector, text, card } of pairings) {
      const ratio = contrast(text, card);
      expect(ratio, `${selector} — ${text} on ${card} is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(7);
    }
  });

  it('caps dark-mode body text below the halation ceiling', () => {
    // The unusual half of this test, and the point of it: in dark mode MORE
    // contrast is not better. Near-white on near-black blooms, and the unread
    // title wears it worst — it reads bold and blurry rather than crisp on a dim
    // panel. A future "improve the contrast" edit would silently bring that
    // back, so the ceiling is asserted, not just the floor.
    const dark = pairings.filter(
      ({ text, card }) => luminance(text) > luminance(card),
    );
    expect(dark.length).toBe(4);
    for (const { selector, text, card } of dark) {
      const ratio = contrast(text, card);
      expect(ratio, `${selector} — ${text} on ${card} is ${ratio.toFixed(2)}:1`)
        .toBeLessThanOrEqual(12);
    }
  });

  it('keeps the two dark palettes within a step of each other', () => {
    // Ink and Grape should read as the same weight of text in the same room; a
    // change to one that skips the other is the drift this catches.
    const dark = pairings.filter(
      ({ text, card }) => luminance(text) > luminance(card),
    );
    const ratios = dark.map(({ text, card }) => contrast(text, card));
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(1);
  });
});
