// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

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
