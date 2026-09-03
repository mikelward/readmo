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

/** Everything outside every `@media` block. `declarationsFor` above does NOT
 * exclude them — the rule regex cannot match across nested braces, so it
 * resumes *inside* a media block and captures the bare inner selector — and
 * the hover-state case relies on exactly that to read `.item-row:hover`. The
 * row's height contract needs the opposite: `.pin-btn` is 44px at base and
 * 36px under `(pointer: fine)`, and merging the two reports only the second.
 * So this is a second reader rather than a change to the first. */
const baseCss = (() => {
  let out = '';
  let cursor = 0;
  const mediaRe = /@media[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = mediaRe.exec(cssNoComments))) {
    out += cssNoComments.slice(cursor, m.index);
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < cssNoComments.length && depth > 0) {
      if (cssNoComments[i] === '{') depth++;
      else if (cssNoComments[i] === '}') depth--;
      i++;
    }
    cursor = i;
    mediaRe.lastIndex = i;
  }
  return out + cssNoComments.slice(cursor);
})();

/** `declarationsFor`, restricted to rules outside every `@media` block. */
function baseDeclarationsFor(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(baseCss))) {
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

/** The vertical half of a `padding` shorthand, in px. A unitless `0` is the
 * value the row-height contract turns on, so it has to parse — reading it as
 * "unrecognized" would make the assertion below vacuous. */
function paddingBlock(selector: string): number | undefined {
  const value = baseDeclarationsFor(selector)['padding'];
  if (!value) return undefined;
  const first = value.split(/\s+/)[0];
  if (first === '0') return 0;
  return first.endsWith('px') ? Number(first.slice(0, -2)) : undefined;
}

describe('row height contract', () => {
  it('keeps the tap floor on the row body and the pin button', () => {
    // Both are flex CHILDREN of .item-row, so either one alone already holds
    // the row's content box at 44px. That is the fact the next case depends
    // on, so it is asserted rather than assumed.
    expect(baseDeclarationsFor('.item-row__body')['min-height']).toBe(
      'var(--rm-tap)',
    );
    expect(baseDeclarationsFor('.pin-btn')['height']).toBe('var(--rm-tap)');
  });

  it('gives the row no vertical padding, so nothing stacks on that floor', () => {
    // The invariant that actually decides the row's height. `min-height` on
    // the row is NOT enough to catch a regression here: it was already at the
    // floor while every row rendered 12px taller, because a child's
    // constraint sets the CONTENT box and the row's own padding is added to
    // it. Restoring `padding: 6px 12px` fails here.
    expect(paddingBlock('.item-row')).toBe(0);
  });

  it('puts the optical inset inside the floor, on the body', () => {
    // Moving the padding is only correct if it survives somewhere — dropping
    // it entirely would tighten the title against the row edge.
    expect(paddingBlock('.item-row__body')).toBeGreaterThan(0);
  });

  it("states SPEC's 48px row minimum on the row itself", () => {
    // The stretched link covers the row, not the inner <a>'s content box, so
    // this is where the floor belongs. It exceeds --rm-tap (44px) on purpose:
    // the touch target and the row's height are different requirements.
    expect(baseDeclarationsFor('.item-row')['min-height']).toBe('48px');
  });

  it('does not double the padding on the card-like variants', () => {
    // --excerpt and --thumbnail pad the ROW out to a card deliberately; with
    // the compact row's inset now on the body, they have to zero it or every
    // card grows by 12px.
    for (const variant of ['.item-row--excerpt', '.item-row--thumbnail']) {
      expect(paddingBlock(variant)).toBe(12);
      expect(paddingBlock(`${variant} .item-row__body`)).toBe(0);
    }
  });
});
