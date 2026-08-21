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

  it('renders the preview a half-step below headline contrast, fading when opened', () => {
    expect(declarationsFor('.item-row__excerpt').color).toBe(
      'color-mix(in srgb, var(--rm-text) 50%, var(--rm-read))',
    );
    expect(declarationsFor('.item-row--opened .item-row__excerpt').color).toBe(
      'var(--rm-read)',
    );
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

/** Bodies of every `@media (hover: hover)` block, via brace matching — the
 * flat-rule helper above can't tell nested rules from base ones. */
function hoverMediaBodies(): string[] {
  const bodies: string[] = [];
  const openRe = /@media\s*\(hover:\s*hover\)\s*\{/g;
  while (openRe.exec(cssNoComments)) {
    let depth = 1;
    let i = openRe.lastIndex;
    while (i < cssNoComments.length && depth > 0) {
      if (cssNoComments[i] === '{') depth++;
      if (cssNoComments[i] === '}') depth--;
      i++;
    }
    bodies.push(cssNoComments.slice(openRe.lastIndex, i - 1));
  }
  return bodies;
}

describe('row interaction states (guardrail #2 / newshacker parity)', () => {
  it('gives the body zone a pressed state, outside the hover media query', () => {
    // The :active rule must fire on touch, so it cannot live inside
    // @media (hover: hover) — see the CSS-gotchas section in SPEC/CLAUDE. The
    // `html:not(.rm-suppress-press)` ancestor guard is usePopoverDismiss's
    // press-suppression contract (see global.css.test.ts) — it doesn't change
    // when the pressed state fires, just gates it off for the span of a press
    // that's dismissing an unrelated popover elsewhere on the page.
    expect(
      declarationsFor('html:not(.rm-suppress-press) .item-row__body:active')
        .background,
    ).toBe('var(--rm-border)');
    for (const body of hoverMediaBodies()) {
      expect(body).not.toContain('.item-row__body:active');
    }
  });

  it('tints the whole row on hover, only on devices that can hover', () => {
    expect(declarationsFor('.item-row:hover').background).toBe('var(--rm-bg)');
    expect(
      hoverMediaBodies().some((body) => body.includes('.item-row:hover')),
    ).toBe(true);
  });

  it('marks the keyboard-focused row at row width and mutes the inner outline', () => {
    const marker = declarationsFor(
      '.item-row:has(.item-row__body:focus-visible)',
    );
    expect(marker['box-shadow']).toBe('inset 0 3px 0 var(--rm-accent)');
    expect(marker.background).toBe('var(--rm-bg)');
    // The row marker replaces the global 2px outline on the stretched link.
    expect(declarationsFor('.item-row__body:focus-visible').outline).toBe(
      'none',
    );
  });
});
