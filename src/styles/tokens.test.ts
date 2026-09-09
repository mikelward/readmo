// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Design-token contract (CLAUDE.md guardrail: use the --rm-* tokens, don't
// hard-code colors). Two failure modes have shipped before and are guarded
// here at the source level, since jsdom can't resolve the cascade:
//
//  1. Referencing a custom property that nothing defines (e.g. the old
//     `--rm-text-muted`, `--skeleton-base`, `--rm-font-mono` fallbacks) —
//     the var() fallback or the inherited value silently wins, so light-mode
//     colors leak into dark mode.
//  2. Giving a global.css token reference a hard-coded fallback
//     (`var(--rm-meta, #6b6b6b)`) — those tokens are always defined on
//     :root, so a fallback is dead weight that masks exactly the typo in
//     failure mode 1. (Properties measured into place from JS, like
//     --rm-group-sticky-top, legitimately carry a pre-measurement fallback
//     and are exempt.)

const SRC_ROOT = new URL('..', import.meta.url).pathname;

function walk(dir: string, ext: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, ext));
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(path);
  }
  return out;
}

const stripCssComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const cssFiles = walk(SRC_ROOT, ['.css']).map((path) => ({
  path,
  source: stripCssComments(readFileSync(path, 'utf8')),
}));

// Properties defined in CSS (`--x: value`)…
const defined = new Set<string>();
for (const { source } of cssFiles) {
  for (const m of source.matchAll(/(?:^|[{;\s])(--[a-z0-9-]+)\s*:/g)) {
    defined.add(m[1]);
  }
}
// …plus properties set from components via inline style
// (`style={{ '--x': … }}`), e.g. --tooltip-x-shift, --rm-group-sticky-top.
for (const path of walk(SRC_ROOT, ['.ts', '.tsx'])) {
  if (/\.test\.tsx?$/.test(path)) continue;
  for (const m of readFileSync(path, 'utf8').matchAll(/'(--[a-z0-9-]+)':/g)) {
    defined.add(m[1]);
  }
}

describe('CSS custom-property contract', () => {
  it('every var(--…) reference resolves to a defined property', () => {
    const undefinedRefs: string[] = [];
    for (const { path, source } of cssFiles) {
      for (const m of source.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        if (!defined.has(m[1])) {
          undefinedRefs.push(`${m[1]} (${path.slice(SRC_ROOT.length)})`);
        }
      }
    }
    expect(undefinedRefs).toEqual([]);
  });

  it('never gives a global.css token reference a fallback value', () => {
    const globalCss = cssFiles.find((f) => f.path.endsWith('styles/global.css'));
    if (!globalCss) throw new Error('styles/global.css not found');
    const tokens = new Set<string>();
    for (const m of globalCss.source.matchAll(/(?:^|[{;\s])(--[a-z0-9-]+)\s*:/g)) {
      tokens.add(m[1]);
    }

    const fallbacks: string[] = [];
    for (const { path, source } of cssFiles) {
      for (const m of source.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,/g)) {
        if (tokens.has(m[1])) {
          fallbacks.push(`${m[1]} (${path.slice(SRC_ROOT.length)})`);
        }
      }
    }
    expect(fallbacks).toEqual([]);
  });
});
