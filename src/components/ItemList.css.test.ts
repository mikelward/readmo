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

  it('overlaps the chrome by 1px so a sub-pixel rounding gap never shows', () => {
    // The offset is summed from the chrome strips' integer offsetHeights, so on
    // fractional-DPI viewports it can land ~1px below the toolbar's true bottom,
    // exposing a white sliver of rows. Pulling the pin up a pixel closes that
    // gap; the overlap tucks invisibly under the higher-z chrome.
    const header = declarationsFor('.item-list__group-header');
    expect(header.top).toContain('- 1px');
    // The matching padding keeps the overlapped pixel non-interactive so the
    // 44px toggle / action buttons start below the toolbar edge and aren't
    // shaved to 43px (guardrail #2's 44px touch floor).
    expect(header['padding-top']).toBe('1px');
  });

  it('stacks the pinned header under the app header + toolbar, over the rows', () => {
    const z = Number(declarationsFor('.item-list__group-header')['z-index']);
    // Below the top toolbar (z 10) and app header (z 20) so it tucks under them;
    // above the item rows (auto) so it covers them as they scroll past.
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(10);
  });

  it('baseline-aligns the feed name and its unread count, then optically centers the count', () => {
    // The title (0.75rem) and the count (0.6875rem) share a baseline group…
    expect(declarationsFor('.item-list__group-label')['align-items']).toBe(
      'baseline',
    );
    // …then the count gets a small upward optical lift so its smaller glyphs
    // center against the title's caps instead of reading as sitting low. Visual
    // only (transform), so the title's baseline and the row layout are unmoved.
    expect(declarationsFor('.item-list__group-count').transform).toContain(
      'translateY(',
    );
  });

  it('keeps the feed name to a single line so the pinned header stays compact', () => {
    // A wrapped two-line feed name would make the sticky header band jump in
    // height as the reader scrolled between sections, so the title truncates.
    const title = declarationsFor('.item-list__group-title');
    expect(title['white-space']).toBe('nowrap');
    expect(title['text-overflow']).toBe('ellipsis');
    expect(title.overflow).toBe('hidden');
  });

  it('floors the focusable name-row tap zones at the 44px touch width', () => {
    // The name row's two focusable controls — the far-left chevron collapse
    // button and the feed-name link — both pin min-width to the tap token so
    // neither drops below the 44px floor: the chevron stays a guaranteed collapse
    // target even beside a long title, and a favicon-less short title can't
    // starve the link (guardrail #2's 44px touch floor). The redundant
    // pointer-only collapse-rest region deliberately has no floor — it may
    // shrink to nothing since the chevron already guarantees a tappable zone.
    expect(declarationsFor('.item-list__group-link')['min-width']).toBe(
      'var(--rm-tap)',
    );
    expect(declarationsFor('.item-list__group-toggle')['min-width']).toBe(
      'var(--rm-tap)',
    );
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
