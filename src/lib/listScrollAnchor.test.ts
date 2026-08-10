import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureListScrollAnchor,
  clearListScrollAnchors,
  getListScrollAnchor,
  measureAnchorDelta,
  saveListScrollAnchor,
} from './listScrollAnchor';

const CHROME_HEIGHT = 100;
const ROW_HEIGHT = 60;

/** Render `count` rows into the document and lay them out under a sticky chrome
 * of CHROME_HEIGHT, as if the window were scrolled to `scrollY`. jsdom has no
 * layout, so every rect is modeled: row `i` sits at document offset
 * `CHROME_HEIGHT + i * ROW_HEIGHT`, and its viewport position is that minus the
 * scroll. `ids` names the rows in order, so a test can drop rows from the top to
 * model the list compacting while it was unmounted. */
function layoutList(ids: string[], scrollY: number): void {
  document.body.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'app-header';
  Object.defineProperty(header, 'offsetHeight', {
    configurable: true,
    value: CHROME_HEIGHT,
  });
  document.body.append(header);
  const list = document.createElement('ul');
  ids.forEach((id, index) => {
    const li = document.createElement('li');
    li.dataset.itemId = id;
    const top = CHROME_HEIGHT + index * ROW_HEIGHT - scrollY;
    li.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    list.append(li);
  });
  document.body.append(list);
}

describe('listScrollAnchor', () => {
  beforeEach(() => {
    clearListScrollAnchors();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    clearListScrollAnchors();
  });

  it('anchors on the first row still showing below the sticky chrome', () => {
    // Scrolled three rows down: rows 0-2 are behind the chrome, row 3 leads.
    layoutList(['a', 'b', 'c', 'd', 'e', 'f'], 3 * ROW_HEIGHT);
    const anchor = captureListScrollAnchor();
    expect(anchor?.rows[0]).toEqual({ id: 'd', top: 0 });
  });

  it('records where a partly-hidden leading row sits, not just which row it is', () => {
    layoutList(['a', 'b', 'c'], ROW_HEIGHT + 20);
    // Row `b` is tucked 20px up behind the chrome — a negative offset, so the
    // restore reproduces the same partial hide rather than snapping it flush.
    expect(captureListScrollAnchor()?.rows[0]).toEqual({ id: 'b', top: -20 });
  });

  it('records following rows as fallbacks, each with its own offset', () => {
    layoutList(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 0);
    const anchor = captureListScrollAnchor();
    // Five rows: the leader plus four fallbacks, spaced a row apart.
    expect(anchor?.rows).toEqual([
      { id: 'a', top: 0 },
      { id: 'b', top: ROW_HEIGHT },
      { id: 'c', top: 2 * ROW_HEIGHT },
      { id: 'd', top: 3 * ROW_HEIGHT },
      { id: 'e', top: 4 * ROW_HEIGHT },
    ]);
  });

  it('skips a row painted over by the grouped view sticky section header', () => {
    // Grouped views pin a section header in the band below the chrome, and it
    // paints over the rows sliding up behind it. A row under there isn't one the
    // reader can see — and it's exactly the row auto-hide treats as scrolled
    // past, so anchoring on it would pick the row likeliest to be dismissed.
    layoutList(['a', 'b', 'c', 'd'], 2 * ROW_HEIGHT);
    const header = document.createElement('div');
    header.className = 'item-list__group-header';
    header.getBoundingClientRect = () =>
      ({
        top: CHROME_HEIGHT,
        bottom: CHROME_HEIGHT + ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: CHROME_HEIGHT,
        toJSON: () => ({}),
      }) as DOMRect;
    document.querySelector('.app-header')!.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: CHROME_HEIGHT,
        height: CHROME_HEIGHT,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.append(header);

    // `c` leads on paper, but the header covers it; `d` is the first row the
    // reader can actually see. The offset is still measured from the chrome, so
    // it records where `d` really sits — a header-height down.
    expect(captureListScrollAnchor()?.rows[0]).toEqual({ id: 'd', top: ROW_HEIGHT });
  });

  it('captures nothing on a route with no rows', () => {
    document.body.innerHTML = '<main>reader</main>';
    expect(captureListScrollAnchor()).toBeNull();
  });

  it('measures the scroll needed to put a dropped-rows list back', () => {
    // Left the list scrolled to row `d`, with a, b, c above it.
    layoutList(['a', 'b', 'c', 'd', 'e', 'f'], 3 * ROW_HEIGHT);
    const anchor = captureListScrollAnchor()!;
    // Came back to a list whose first three rows were dismissed while away. The
    // browser restored the same pixel offset, so `d` has slid three rows up —
    // out of view behind the chrome, with `g`-ward rows in its place. That's the
    // reported jump; the delta undoes it.
    layoutList(['d', 'e', 'f'], 3 * ROW_HEIGHT);
    expect(measureAnchorDelta(anchor)).toBe(-3 * ROW_HEIGHT);
  });

  it('falls back to a following row when the anchor row itself is gone', () => {
    layoutList(['a', 'b', 'c', 'd'], 0);
    const anchor = captureListScrollAnchor()!;
    // `a` was the story the reader opened, and a mark-done-on-open feed dropped
    // it. `b` now leads the list, and restoring against its own recorded offset
    // keeps the view where `a` was — not a row-height off.
    layoutList(['b', 'c', 'd'], 0);
    expect(measureAnchorDelta(anchor)).toBe(-ROW_HEIGHT);
  });

  it('reports no delta while none of the anchor rows has rendered', () => {
    layoutList(['a', 'b', 'c'], 0);
    const anchor = captureListScrollAnchor()!;
    // Mid-hydration: the list is still empty, which must read as "not yet"
    // (retry) rather than "already in place".
    document.body.innerHTML = '';
    expect(measureAnchorDelta(anchor)).toBeNull();
  });

  it('keeps a separate anchor per history entry', () => {
    saveListScrollAnchor('k1', { rows: [{ id: 'a', top: 0 }] });
    saveListScrollAnchor('k2', { rows: [{ id: 'z', top: 12 }] });
    expect(getListScrollAnchor('k1')?.rows[0].id).toBe('a');
    expect(getListScrollAnchor('k2')?.rows[0].id).toBe('z');
    expect(getListScrollAnchor('k3')).toBeNull();
  });

  it('evicts the oldest entries rather than growing for the life of the tab', () => {
    for (let i = 0; i < 25; i += 1) {
      saveListScrollAnchor(`k${i}`, { rows: [{ id: `row${i}`, top: 0 }] });
    }
    expect(getListScrollAnchor('k0')).toBeNull();
    expect(getListScrollAnchor('k4')).toBeNull();
    expect(getListScrollAnchor('k5')?.rows[0].id).toBe('row5');
    expect(getListScrollAnchor('k24')?.rows[0].id).toBe('row24');
  });

  it('re-saving an entry keeps it from being evicted as the oldest', () => {
    saveListScrollAnchor('k0', { rows: [{ id: 'first', top: 0 }] });
    for (let i = 1; i < 20; i += 1) {
      saveListScrollAnchor(`k${i}`, { rows: [{ id: `row${i}`, top: 0 }] });
    }
    // Scrolling the oldest view again refreshes its place in the queue, so the
    // next write evicts k1 instead of the entry the reader is actually using.
    saveListScrollAnchor('k0', { rows: [{ id: 'again', top: 0 }] });
    saveListScrollAnchor('k20', { rows: [{ id: 'row20', top: 0 }] });
    expect(getListScrollAnchor('k0')?.rows[0].id).toBe('again');
    expect(getListScrollAnchor('k1')).toBeNull();
  });
});
