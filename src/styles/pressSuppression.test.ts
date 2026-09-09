// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// usePopoverDismiss adds .rm-suppress-press to <html> for the span of a press
// that dismisses a popover/menu outside it — the click that press would have
// fired is already swallowed, but the browser paints :active on whatever it
// landed on regardless of that JS handling. Every `:active` rule in the app
// therefore needs to be gated behind `html:not(.rm-suppress-press)` so that
// press-suppression window simply stops the rule from matching (leaving
// whatever ELSE the cascade supplies — the element's real resting/hover
// style — untouched), rather than overwriting its declarations with a
// guessed reset value. This is a repo-wide invariant: it has to hold for a
// selector added tomorrow just as much as for the ones that exist today, so
// it's asserted by scanning every stylesheet rather than by naming each file.

function allCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allCssFiles(path));
    else if (entry.name.endsWith('.css')) out.push(path);
  }
  return out;
}

const SRC_DIR = new URL('..', import.meta.url).pathname;

describe('pressed-state suppression covers every :active rule', () => {
  it('gates every :active selector behind html:not(.rm-suppress-press)', () => {
    const offenders: string[] = [];
    for (const file of allCssFiles(SRC_DIR)) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const ruleRe = /([^{}]+)\{[^{}]*\}/g;
      let m: RegExpExecArray | null;
      while ((m = ruleRe.exec(css))) {
        for (const selector of m[1].split(',').map((s) => s.trim())) {
          if (!selector.includes(':active')) continue;
          if (selector.startsWith('html:not(.rm-suppress-press)')) continue;
          offenders.push(`${file}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
