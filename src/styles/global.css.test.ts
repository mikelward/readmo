// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT_SIZE, FONT_SIZES } from '../lib/theme';

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

describe('the header scales with the text size, and only the header', () => {
  const root = declarationsFor(':root');

  // The whole point, and the thing a later "simplify" would undo: a hard 56px
  // header is what capped the text-size ladder, because the brand inside it is
  // `1.25rem` and clips once the root outgrows the bar.
  it('sizes the header in rem', () => {
    expect(root['--rm-header-h']).toContain('rem');
  });

  // `max()` keeps it from shrinking at the smaller text sizes, where a bare
  // `rem` would drop it below the 56px it has always been.
  it('holds the 56px header floor with max()', () => {
    expect(root['--rm-header-h']).toMatch(/^max\(\s*56px\s*,/);
  });

  // At the 16px default the rem half resolves to exactly the old value, so this
  // is a no-op for anyone who never moves the setting.
  it('resolves to the previous fixed size at the default root', () => {
    const rem = Number(/([\d.]+)rem/.exec(root['--rm-header-h'])?.[1]);
    expect(rem * 16).toBe(56);
  });

  // The tap target deliberately does NOT scale, and this is the regression
  // guard: three separate fixed-width rows broke when it did. 44px is an
  // accessibility floor, not a design value, and what these controls contain is
  // a fixed 24px icon — so a wider button shows nothing more while costing the
  // row. The reader's action bar is the tightest: five controls across 320px
  // leave 100px for the feed name at 44px and 59px at a scaled 52px.
  it('keeps the tap target at the bare 44px floor', () => {
    expect(root['--rm-tap']).toBe('44px');
  });

  it('leaves five tap targets and a readable feed name inside a 320px bar', () => {
    const tap = Number(/(\d+)px/.exec(root['--rm-tap'])?.[1]);
    expect(320 - 5 * tap).toBeGreaterThanOrEqual(96);
  });

  // Spacing doesn't scale either: the chrome grows to fit its own contents, so
  // large text buys more article on screen rather than a bigger logo.
  it('leaves the spacing grid alone', () => {
    expect(root['--rm-radius']).toBe('10px');
  });
});

// The bug this exists for: `FONT_SIZES` gained 26-32 while this stylesheet
// still stopped at 24, so picking one set `data-font-size="32"`, persisted it,
// and displayed "32px" in the stepper while the text fell back to the root
// 16px default. Every test in the suite asserted the *attribute*, so all of
// them stayed green over it.
describe('text-size ladder', () => {
  it('defines a token override for every rung except the default', () => {
    const declared = new Set(
      Array.from(
        css.matchAll(/:root\[data-font-size='(\d+)'\]/g),
        (m) => m[1],
      ),
    );
    // Assert the scan found something before trusting a set difference — an
    // empty set differences to empty and passes while checking nothing.
    expect(declared.size).toBeGreaterThan(0);

    // 16px owns the bare `:root`, so it is deliberately not in the attribute
    // list; every other rung must be.
    const expected = FONT_SIZES.filter((size) => size !== DEFAULT_FONT_SIZE);
    expect([...declared].sort()).toEqual([...expected].sort());
  });

  it('maps each rung to its own px value', () => {
    for (const size of FONT_SIZES) {
      if (size === DEFAULT_FONT_SIZE) continue;
      const rule = new RegExp(
        `:root\\[data-font-size='${size}'\\]\\s*\\{[^}]*--rm-font-size:\\s*${size}px`,
      );
      expect(css).toMatch(rule);
    }
  });
});
