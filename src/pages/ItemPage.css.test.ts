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

describe('reader body typography contract', () => {
  // SPEC.md "Reader view → Body": long-form article copy is set one step
  // larger and denser than newshacker's 15px comment text. Sized in `rem`
  // (1rem = 16px at the default root) so the body tracks the Settings
  // "Text size" choice; guards both against a silent revert to the smaller
  // 15px / 1.6 the reader shipped with AND against pinning it back to px,
  // which would stop it scaling with the text-size setting.
  it('sets 1rem (16px at default) body copy with 1.4 line-height', () => {
    const body = declarationsFor('.reader__body');
    expect(body['font-size']).toBe('1rem');
    expect(body['line-height']).toBe('1.4');
  });

  // The sanitizer strips <small> at storage time (presentational lede, e.g. The
  // Economist's small-caps opener), but items stored before that change still
  // carry the tag. This rule pins any surviving <small> to body size so those
  // words don't render at the UA's shrunken default mid-paragraph.
  it('neutralizes <small> size so a stored lede tracks body copy', () => {
    expect(declarationsFor('.reader__body small')['font-size']).toBe('inherit');
  });
});

describe('standalone image sizing contract', () => {
  // SPEC.md "Reader view → Body": standalone images are full-bleed, but a
  // source narrower than the reading column must NOT be upscaled (that's what
  // made low-res images blurry). The guard: block images cap at their intrinsic
  // size via `width: auto` + `max-width` rather than a forced `width`.
  for (const selector of [
    '.reader__body > img',
    '.reader__body > figure img',
    '.reader__body > picture img',
    '.reader__body > table img',
  ]) {
    it(`does not force-upscale ${selector}`, () => {
      const decl = declarationsFor(selector);
      // A forced `width: 100%` / `calc(...)` is the upscaling bug; width must
      // track the intrinsic size instead.
      expect(decl.width).toBe('auto');
      // Still bounded to the column / full feed area.
      expect(decl['max-width']).toBeDefined();
    });
  }

  // Direct-child images and reflowed-table images are *wider* than their padded
  // containing block at full-bleed, so the breakout must be an explicit -16px
  // margin, NOT `margin: auto` — per CSS 2.1 §10.3.3 auto margins collapse to 0
  // for an over-wide block, dropping the left breakout and overflowing right.
  for (const selector of ['.reader__body > img', '.reader__body > table img']) {
    it(`breaks ${selector} out of the body padding with a fixed -16px margin`, () => {
      const decl = declarationsFor(selector);
      expect(decl['margin-left']).toBe('-16px');
      // Must not reintroduce the buggy auto-centering on the over-wide box.
      expect(decl['margin-right']).not.toBe('auto');
    });
  }

  // Figure/picture images sit inside an already-broken-out band (the wrapper
  // carries the -16px margins), so `max-width: 100%` never exceeds the
  // containing block: auto margins are safe and center sub-band images.
  for (const selector of [
    '.reader__body > figure img',
    '.reader__body > picture img',
  ]) {
    it(`centers ${selector} within its breakout band`, () => {
      const decl = declarationsFor(selector);
      expect(decl['max-width']).toBe('100%');
      expect(decl['margin-left']).toBe('auto');
      expect(decl['margin-right']).toBe('auto');
    });
  }
});
