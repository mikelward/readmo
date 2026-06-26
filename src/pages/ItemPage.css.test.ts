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

const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Split the stylesheet into its top-level (base) source and each `@media`
 * block's inner source, matching braces so nested rules aren't truncated. The
 * sheet is flat (no nested @media), so a single depth counter suffices. */
function splitMedia(src: string): { base: string; media: { cond: string; body: string }[] } {
  const media: { cond: string; body: string }[] = [];
  let base = '';
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf('@media', i);
    if (at === -1) {
      base += src.slice(i);
      break;
    }
    base += src.slice(i, at);
    const open = src.indexOf('{', at);
    const cond = src.slice(at + '@media'.length, open).trim();
    let depth = 1;
    let j = open + 1;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
    }
    media.push({ cond, body: src.slice(open + 1, j - 1) });
    i = j;
  }
  return { base, media };
}

const { base: baseCss, media: mediaBlocks } = splitMedia(cssNoComments);

/** Merge every declaration block whose (possibly grouped) selector list
 * contains `selector` within `scope`, returning a `prop -> value` map.
 * Later rules win (source order), mirroring the cascade for equal specificity. */
function declarationsIn(scope: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(scope))) {
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

/** Base (mobile-first, outside any @media) declarations for `selector`. */
function declarationsFor(selector: string): Record<string, string> {
  return declarationsIn(baseCss, selector);
}

/** Declarations for `selector` inside the @media block whose condition
 * contains `condSubstring` (e.g. 'min-width: 960px'). */
function declarationsAt(condSubstring: string, selector: string): Record<string, string> {
  const block = mediaBlocks.find((b) => b.cond.includes(condSubstring));
  if (!block) throw new Error(`no @media block matching "${condSubstring}"`);
  return declarationsIn(block.body, selector);
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
  // SPEC.md "Reader view → Body": standalone images are full-bleed. On MOBILE
  // they fill the column even when the source is narrower (a small Reddit
  // preview thumbnail should lead full-bleed, not sit tiny inline-size), so the
  // base (mobile-first) rules force a `width`. The intrinsic-size cap that
  // avoids upscaling low-res sources is reapplied only on the desktop wide
  // layout (≥960px), where whitespace frames the column and upscaling looks
  // worst — see the desktop block below.

  it('fills the column full-bleed on mobile for a direct-child image', () => {
    const decl = declarationsFor('.reader__body > img');
    expect(decl.width).toBe('calc(100% + 32px)');
    expect(decl['max-width']).toBe('calc(100% + 32px)');
  });

  it('fills the column full-bleed on mobile for a reflowed-table image', () => {
    const decl = declarationsFor('.reader__body > table img');
    expect(decl.width).toBe('calc(100% + 32px)');
    expect(decl['max-width']).toBe('calc(100% + 32px)');
  });

  for (const selector of [
    '.reader__body > figure img',
    '.reader__body > picture img',
  ]) {
    it(`fills the breakout band full-bleed on mobile for ${selector}`, () => {
      const decl = declarationsFor(selector);
      expect(decl.width).toBe('100%');
      expect(decl['max-width']).toBe('100%');
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
  // carries the -16px margins), so auto side margins are safe and center a
  // sub-band image once the desktop cap lets it shrink below the band.
  for (const selector of [
    '.reader__body > figure img',
    '.reader__body > picture img',
  ]) {
    it(`centers ${selector} within its breakout band`, () => {
      const decl = declarationsFor(selector);
      expect(decl['margin-left']).toBe('auto');
      expect(decl['margin-right']).toBe('auto');
    });
  }

  // Desktop wide layout: the cap returns. Every standalone image drops to
  // `width: auto` so a source narrower than the column renders at its intrinsic
  // size instead of being upscaled and blurred.
  for (const selector of [
    '.reader__body > img',
    '.reader__body > figure img',
    '.reader__body > picture img',
    '.reader__body > table img',
  ]) {
    it(`caps ${selector} at intrinsic size on the ≥960px desktop layout`, () => {
      expect(declarationsAt('min-width: 960px', selector).width).toBe('auto');
    });
  }
});
