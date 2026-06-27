// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Raw-CSS guards for the desktop reading-column widening (SPEC § App header
// layout, global.css). jsdom doesn't evaluate `@media (min-width: …)` against
// a real viewport, so matching the source is the most reliable way to stop the
// rules from silently drifting back to the phone-only 720px layout. Mirrors
// newshacker's src/styles/desktopWidth.test.tsx.

const globalCss = readFileSync(new URL('./global.css', import.meta.url), 'utf8');
const headerCss = readFileSync(
  new URL('../components/AppHeader.css', import.meta.url),
  'utf8',
);

describe('desktop wider-column invariants', () => {
  it('bumps .app-main to 860px at min-width: 960px', () => {
    // Phone baseline is still 720px.
    expect(globalCss).toMatch(/\.app-main\s*\{[^}]*max-width:\s*720px/s);
    // Desktop bump: @media (min-width: 960px) { .app-main { max-width: 860px } }
    expect(globalCss).toMatch(
      /@media\s*\(min-width:\s*960px\)\s*\{\s*\.app-main\s*\{[^}]*max-width:\s*860px/s,
    );
  });

  it('keeps the header a flat left-hugging row that does not track the column widen', () => {
    // Matching newshacker (guardrail #9): the header inner just fills the track
    // between the edge controls — it is never width-capped or centered, so the
    // brand stays pinned beside the menu button at every width and the wordmark
    // never floats toward the (widening) content column on desktop.
    expect(headerCss).not.toMatch(/\.app-header__inner\s*\{[^}]*max-width/s);
    expect(headerCss).not.toMatch(/\.app-header__inner\s*\{[^}]*margin:\s*0\s+auto/s);
    // No desktop centering breakpoint on the header row.
    expect(headerCss).not.toMatch(/\.app-header\s*\{[^}]*justify-content:\s*center/s);
  });
});
