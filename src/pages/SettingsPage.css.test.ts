// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guardrail 2's tap contract for the Settings chips — the segmented pickers
// (Font, Article layout, Bottom toolbar, Sort order, Save to, and the two
// article size pickers) plus the plain buttons, all sharing one rule.
//
// jsdom computes no layout, so assert the SOURCE contract the way the other
// *.css.test.ts files do. Two things a reader can't see going wrong:
//
//  - The size pickers label their chips with a bare number, and "5" is the
//    narrowest label in the app. `min-height` alone left the target's WIDTH to
//    32px of padding plus glyph metrics plus the reader's chosen text size —
//    around 42px at the smaller sizes, under the 44px floor, and silently so.
//  - No `:active` rule meant no pointer-down feedback: the only visual change
//    was the selection landing after the click, and re-picking the current
//    value changed nothing at all.
//
// Both surfaced on PR #667 (Codex P1) when the "5" chip introduced the first
// single-character label.
const css = readFileSync(new URL('./SettingsPage.css', import.meta.url), 'utf8');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block of the first rule whose selector list matches. */
function ruleBody(selectorPattern: RegExp): string {
  const match = cssNoComments.match(
    new RegExp(`${selectorPattern.source}[^{]*\\{([^}]*)\\}`),
  );
  expect(match, `no rule matching ${selectorPattern}`).not.toBeNull();
  return match![1];
}

describe('SettingsPage.css — chip tap targets', () => {
  it('floors both axes of the shared chip at the tap size', () => {
    const body = ruleBody(/\.settings__theme-btn/);
    expect(body).toMatch(/min-height:\s*var\(--rm-tap\)/);
    expect(body).toMatch(/min-width:\s*var\(--rm-tap\)/);
  });

  it('gives the chips a pressed state, under the press-suppression guard', () => {
    // The app-wide convention: `html:not(.rm-suppress-press) …:active`, so a
    // pointer device that shouldn't flash a press can opt the whole page out.
    expect(cssNoComments).toMatch(
      /html:not\(\.rm-suppress-press\)\s+\.settings__theme-btn:active\s*[,{]/,
    );
  });

  it('tints the pressed state with the accent, so it reads on a selected chip', () => {
    const body = ruleBody(
      /html:not\(\.rm-suppress-press\)\s+\.settings__btn:active,\s*html:not\(\.rm-suppress-press\)\s+\.settings__theme-btn:active/,
    );
    expect(body).toMatch(/background:\s*color-mix\([^)]*--rm-accent/);
  });
});
