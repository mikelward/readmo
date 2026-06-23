import { afterEach, describe, expect, it } from 'vitest';
import { measureStickyBottomInset, measureStickyInset } from './stickyInset';

// Regression for the Codex review on PR #299: with the list toolbar
// sticky-pinned just below the header, the sweep IntersectionObserver's
// rootMargin must subtract *both* heights — not the header's alone —
// or rows partially hidden behind the toolbar still count as "fully
// visible" and get swept without the reader seeing them.

function makeStickyEl(className: string, bottom: number): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () =>
      ({
        top: bottom - 48,
        right: 0,
        bottom,
        left: 0,
        width: 0,
        height: 48,
        x: 0,
        y: bottom - 48,
        toJSON() {
          return {};
        },
      }) as DOMRect,
    configurable: true,
  });
  document.body.appendChild(el);
  return el;
}

describe('measureStickyInset', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns 0 when neither sticky element is in the DOM', () => {
    expect(measureStickyInset()).toBe(0);
  });

  it('returns the header bottom when only the header is mounted', () => {
    makeStickyEl('app-header', 56);
    expect(measureStickyInset()).toBe(56);
  });

  it('returns the toolbar bottom when both are stacked sticky', () => {
    makeStickyEl('app-header', 56);
    makeStickyEl('list-toolbar', 104);
    expect(measureStickyInset()).toBe(104);
  });

  it('takes the max bottom regardless of DOM order', () => {
    // If the toolbar were measured before the header for some reason,
    // the result must still reflect whichever sticky strip sits
    // lower in the viewport.
    makeStickyEl('list-toolbar', 104);
    makeStickyEl('app-header', 56);
    expect(measureStickyInset()).toBe(104);
  });

  it('ceils a sub-pixel bottom', () => {
    makeStickyEl('app-header', 56.4);
    makeStickyEl('list-toolbar', 104.2);
    expect(measureStickyInset()).toBe(105);
  });

  it('clamps a negative bottom (scrolled-off element) to 0', () => {
    makeStickyEl('app-header', -10);
    expect(measureStickyInset()).toBe(0);
  });
});

// Codex P2 on PR #44: readmo's bottom toolbar is `position: sticky; bottom: 0`,
// so it overlays the last rows — unlike newshacker's relative footer. Sweep
// must also subtract its height, or a row tucked behind it counts as fully
// visible and gets swept unseen.
describe('measureStickyBottomInset', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // makeStickyEl sets the element's top to `bottom - 48`; the bottom inset is
  // `innerHeight - top`, so with innerHeight 768 a top at 720 intrudes 48px.
  function setInnerHeight(value: number) {
    Object.defineProperty(window, 'innerHeight', { value, configurable: true });
  }

  it('returns 0 when the bottom toolbar is absent', () => {
    setInnerHeight(768);
    expect(measureStickyBottomInset()).toBe(0);
  });

  it('returns the toolbar height when pinned at the viewport foot', () => {
    setInnerHeight(768);
    makeStickyEl('list-toolbar list-toolbar--bottom', 768); // top = 720
    expect(measureStickyBottomInset()).toBe(48);
  });

  it('clamps to 0 when the toolbar sits below the fold (normal flow)', () => {
    setInnerHeight(500);
    // top = 760, well past the 500px viewport bottom → negative intrusion.
    makeStickyEl('list-toolbar list-toolbar--bottom', 808);
    expect(measureStickyBottomInset()).toBe(0);
  });

  it('ceils a sub-pixel intrusion', () => {
    setInnerHeight(768);
    makeStickyEl('list-toolbar list-toolbar--bottom', 767.6); // top = 719.6
    expect(measureStickyBottomInset()).toBe(Math.ceil(768 - 719.6));
  });
});
