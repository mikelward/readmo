import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useInViewIds } from './useInViewIds';

// The sweep IntersectionObserver must shrink its root by the sticky chrome on
// *both* edges: the header + top toolbar above, and readmo's pinned bottom
// toolbar below (Codex P2 on PR #44 — newshacker only needs the top edge
// because its footer is `position: relative`).

let lastInit: IntersectionObserverInit | undefined;

function Probe() {
  useInViewIds();
  return null;
}

function mountSticky(className: string, bottom: number): void {
  const el = document.createElement('div');
  el.className = className;
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
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
  });
  document.body.appendChild(el);
}

describe('useInViewIds', () => {
  beforeEach(() => {
    lastInit = undefined;
    class FakeIO {
      constructor(
        _cb: IntersectionObserverCallback,
        init?: IntersectionObserverInit,
      ) {
        lastInit = init;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    Object.defineProperty(window, 'innerHeight', {
      value: 768,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shrinks the observer root by both the top and bottom sticky insets', () => {
    mountSticky('app-header', 56);
    mountSticky('list-toolbar', 104); // top chrome bottom = 104
    mountSticky('list-toolbar list-toolbar--bottom', 768); // pinned, height 48
    render(<Probe />);
    expect(lastInit?.rootMargin).toBe('-104px 0px -48px 0px');
  });

  it('observes the fully-visible cutoff as a threshold so it fires on crossings', () => {
    // The predicate treats ratio >= 0.999 as visible; the observer must watch
    // that same value, or a row dropping from ~0.9995 to behind the chrome
    // would never get a follow-up callback (no [0, 1] boundary is crossed).
    mountSticky('app-header', 56);
    render(<Probe />);
    expect(lastInit?.threshold).toEqual([0, 0.999, 1]);
  });

  it('uses a zero bottom margin when no bottom toolbar is pinned', () => {
    mountSticky('app-header', 56);
    mountSticky('list-toolbar', 104);
    render(<Probe />);
    expect(lastInit?.rootMargin).toBe('-104px 0px -0px 0px');
  });
});
