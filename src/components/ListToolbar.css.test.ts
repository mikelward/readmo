// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The bottom bar's positioning contract. jsdom computes no layout — no sticky,
// no flex, no viewport units — so, like ItemList.css.test.ts, we assert the
// source rules rather than the rendering.
//
// What they buy: a list container used to end right under its content, so
// anything shorter than the screen (a refresh spinner, an empty result, three
// rows) left the bar hanging in the middle of the page and jumped it down as
// rows arrived. The host now grows to the foot of `.app-main`'s floored column
// (global.css.test.ts guards that half), and the bar bottoms out in it.

const css = readFileSync(new URL('./ListToolbar.css', import.meta.url), 'utf8');
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Merge every flat declaration block whose (possibly grouped) selector list
 * contains exactly `selector`, returning a `prop -> value` map. */
function declarationsFor(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [prop, value] of allDeclarations(selector)) out[prop] = value;
  return out;
}

function allDeclarations(selector: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  // Match a flat rule body: a selector list, then a `{...}` with no nested
  // braces. `calc(...)` values contain parentheses but never braces, so the
  // declarations survive intact.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(cssNoComments))) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const [prop, ...rest] = decl.split(':');
      if (!prop.trim() || rest.length === 0) continue;
      out.push([prop.trim(), rest.join(':').trim()]);
    }
  }
  return out;
}

describe('bottom bar positioning contract', () => {
  it('lays the host out as a column so the bar is its last item', () => {
    const host = declarationsFor('.list-toolbar-host');
    expect(host.display).toBe('flex');
    expect(host['flex-direction']).toBe('column');
  });

  it('grows the host to the foot of the page column, never shrinking it', () => {
    // `1 0 auto`: take the slack `.app-main` leaves below any page header, and
    // never compress below the rows' own height. A `min-height` here instead
    // would have to guess at that header, and would overshoot into a scrollbar
    // on the routes that have one (/feed/:feedId, /folder/:name).
    expect(declarationsFor('.list-toolbar-host').flex).toBe('1 0 auto');
  });

  it('lets the host span the page column\u2019s safe-area padding', () => {
    // `.app-main`'s bottom padding sits inside its border-box min-height, so a
    // host that fills the content box stops one inset above the screen edge —
    // on top of the inset the bar's own row already pads by, and out of step
    // with the pinned bar, which ignores that padding once it sticks at
    // `bottom: 0`. The row owns the clearance; the host takes the padding back.
    expect(declarationsFor('.list-toolbar-host')['margin-bottom']).toBe(
      'calc(-1 * env(safe-area-inset-bottom))',
    );
    // The clearance itself stays exactly where it was.
    expect(
      declarationsFor('.list-toolbar--bottom .list-toolbar__row')[
        'padding-bottom'
      ],
    ).toBe('max(4px, env(safe-area-inset-bottom))');
  });

  it('bottoms the bar out in that column in both positions', () => {
    // The auto margin is on the shared --bottom rule, not the relative variant:
    // a `bottom` inset only shifts a sticky box UP, so the pinned bar would
    // otherwise sit wherever short content left it, tall host or not.
    expect(declarationsFor('.list-toolbar--bottom')['margin-top']).toBe('auto');
  });

  it('keeps the relative bar in flow and the pinned bar sticky', () => {
    // `list` (default): in normal flow, so it never overlaps a row.
    expect(
      declarationsFor('.list-toolbar--bottom.list-toolbar--relative').position,
    ).toBe('static');
    // `screen`: drops the --relative class and keeps the sticky rule, so once
    // the list is tall enough the bar rides the viewport foot as before.
    expect(declarationsFor('.list-toolbar').position).toBe('sticky');
    expect(declarationsFor('.list-toolbar--bottom').bottom).toBe('0');
  });
});
