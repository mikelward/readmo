// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The group-by-feed section header layout contract: each feed's header is
// pinned (position: sticky) below the top chrome so it stays on screen while
// scrolling through a section taller than the viewport, rather than scrolling
// off with its first rows. jsdom can't compute sticky layout, so — like
// ItemPage.css.test.ts — we assert the source contract instead of the rendering.
const css = readFileSync(new URL('./ItemList.css', import.meta.url), 'utf8');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Merge every flat declaration block whose (possibly grouped) selector list
 * contains exactly `selector`, returning a `prop -> value` map. The sheet's
 * @media / @keyframes blocks contribute their inner rules as separate flat
 * matches, which is fine: the base `.item-list__group-header` rule is the only
 * one whose selector list is exactly that string. */
function declarationsFor(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(cssNoComments))) {
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

describe('group-by-feed section header positioning contract', () => {
  it('pins each feed header so it stays on screen past one page of rows', () => {
    expect(declarationsFor('.item-list__group-header').position).toBe('sticky');
  });

  it('offsets the pin to the measured top chrome height with a one-row fallback', () => {
    const top = declarationsFor('.item-list__group-header').top;
    // Measured value (set by ItemList) wins; the fallback covers first paint and
    // sums the header + a single 44px toolbar row.
    expect(top).toContain('var(--rm-group-sticky-top');
    expect(top).toContain('--rm-header-h');
    expect(top).toContain('--rm-tap');
  });

  it('stacks the pinned header under the app header + toolbar, over the rows', () => {
    const z = Number(declarationsFor('.item-list__group-header')['z-index']);
    // Below the top toolbar (z 10) and app header (z 20) so it tucks under them;
    // above the item rows (auto) so it covers them as they scroll past.
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(10);
  });

  it('keeps the feed name to a single line so the pinned header stays compact', () => {
    // A wrapped two-line feed name would make the sticky header band jump in
    // height as the reader scrolled between sections, so the title truncates.
    const title = declarationsFor('.item-list__group-title');
    expect(title['white-space']).toBe('nowrap');
    expect(title['text-overflow']).toBe('ellipsis');
    expect(title.overflow).toBe('hidden');
  });

  it('bounds the sticky header to its own section container', () => {
    // The section <li> is the header's sticky containing block, so only the
    // current feed's header is ever pinned (earlier ones are pushed out, not
    // left stuck behind the visible header). It must stay a plain block — no
    // overflow/transform, which would break the descendant sticky.
    const section = declarationsFor('.item-list__section');
    expect(section.overflow).toBeUndefined();
    expect(section.transform).toBeUndefined();
  });
});
