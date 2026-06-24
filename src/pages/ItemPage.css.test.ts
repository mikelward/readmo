// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The reader's layout contract (SPEC.md "Reader action bar"): the top toolbar
// stays pinned (position: sticky) so every action is reachable mid-read, while
// the bottom toolbar is a relative end-of-article footer — NOT sticky, and not
// pinned to the viewport foot with `bottom: 0`. This guards against silently
// reverting to two sticky bars (the newshacker divergence this change undid):
// jsdom can't compute sticky layout, so we assert the source contract instead.
const css = readFileSync(new URL('./ItemPage.css', import.meta.url), 'utf8');

/** Merge every declaration block whose (possibly grouped) selector list
 * contains `selector`, returning a `prop -> value` map. Comments are stripped
 * first and grouped selectors are split on commas; `[^{}]*` for the body skips
 * `@media` wrappers and only matches their inner rules. Good enough for this
 * flat, hand-written stylesheet. */
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

describe('reader toolbar positioning contract', () => {
  it('keeps the top bar sticky so actions stay reachable mid-read', () => {
    expect(declarationsFor('.reader__topbar').position).toBe('sticky');
  });

  it('leaves the bottom bar a relative footer — not sticky, not pinned', () => {
    const bottom = declarationsFor('.reader__bottombar');
    expect(bottom.position).not.toBe('sticky');
    expect(bottom.bottom).toBeUndefined();
  });
});
