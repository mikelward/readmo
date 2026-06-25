// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Group-by-feed section headers read as white cards in light mode rather than
// the off-white page background, so each feed's run of rows is introduced by a
// crisp white band. jsdom can't compute applied CSS, so we assert the source
// contract: the header uses the white card token (#ffffff in light mode) and
// the tappable toggle's pressed state inverts to the page-background token so
// the press still gives visible feedback (guardrail #2: pressed-state on every
// zone) instead of pressing white-on-white.
const css = readFileSync(new URL('./ItemList.css', import.meta.url), 'utf8');

/** Merge every declaration block whose (possibly grouped) selector list
 * contains `selector`, returning a `prop -> value` map. Mirrors the helper in
 * ItemPage.css.test.ts: comments are stripped, grouped selectors split on
 * commas, and `[^{}]*` for the body skips `@media` wrappers. */
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

describe('feed group header background contract', () => {
  it('paints the header with the white card token, not the page background', () => {
    expect(declarationsFor('.item-list__group-header').background).toBe(
      'var(--rm-bg-card)',
    );
  });

  it('inverts the pressed toggle to the page background so the press shows', () => {
    expect(declarationsFor('.item-list__group-toggle:active').background).toBe(
      'var(--rm-bg)',
    );
  });
});
