// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The "Title + thumbnail" layout's placement is a user-visible contract
// (SPEC.md "Article layout"): the lead thumbnail floats to the RIGHT of the
// card, gutter on its left, so the title wraps beside it. jsdom doesn't apply
// the imported stylesheet, so — like ItemPage.css.test.ts — we assert the
// source declarations instead. This guards against a silent mirror back to
// `float: left` / the old right-side gutter.
const css = readFileSync(new URL('./ItemRow.css', import.meta.url), 'utf8');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Merge every base declaration block whose (possibly grouped) selector list
 * contains `selector`, returning a `prop -> value` map. Selectors nested in
 * `@media` blocks carry the media condition in their captured selector text, so
 * they never equal a bare selector — a base-only lookup is all we need here. */
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

describe('excerpt preview contract', () => {
  it('clamps the excerpt preview to two lines (SPEC "Article layout")', () => {
    expect(declarationsFor('.item-row__excerpt')['-webkit-line-clamp']).toBe('2');
  });
});

describe('thumbnail placement contract', () => {
  it('floats the lead thumbnail to the right', () => {
    expect(declarationsFor('.item-row__lead').float).toBe('right');
  });

  it('puts the gutter on the left of the thumbnail, not the right', () => {
    // margin shorthand is top/right/bottom/left — the left gutter is the 4th
    // value (12px) and the right value is 0, so the title sits to the image's
    // left. A revert to the old `2px 12px 4px 0` (left-float gutter) fails here.
    expect(declarationsFor('.item-row__lead').margin).toBe('2px 0 4px 12px');
  });

  it('shrinks the thumbnail (still right, gutter on the left) in the small variant', () => {
    const decl = declarationsFor('.item-row--thumbnail-small .item-row__lead');
    // Smaller than the base 116px, and the gutter stays on the left.
    expect(decl.width).toBe('72px');
    expect(decl.margin).toBe('0 0 0 12px');
  });
});
