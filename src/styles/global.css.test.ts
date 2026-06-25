// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

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

describe('page-level scrollbar gutter', () => {
  // Without this, the viewport width changes between short pages (no
  // scrollbar) and pages tall enough to scroll (scrollbar takes ~15px), and
  // the layout shifts horizontally on every navigation that crosses the
  // threshold.
  it('reserves a stable scrollbar gutter on <html>', () => {
    expect(declarationsFor('html')['scrollbar-gutter']).toBe('stable');
  });
});
