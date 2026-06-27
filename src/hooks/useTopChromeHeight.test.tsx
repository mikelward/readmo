import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useTopChromeHeight } from './useTopChromeHeight';

// The group-by-feed section headers pin below the app header + top toolbar, so
// this hook measures that combined layout height (`offsetHeight`, scroll-
// independent) and re-measures when the chrome reflows — most importantly the
// toolbar wrapping to a second row on ultra-narrow phones, which is exactly the
// grouped view where the headers render.

type ResizeCallback = () => void;

interface MockObserverState {
  callback: ResizeCallback;
  observed: Element[];
  disconnected: boolean;
}

let lastObserver: MockObserverState | null = null;

function makeMockRO() {
  return function MockRO(cb: ResizeCallback) {
    const state: MockObserverState = {
      callback: cb,
      observed: [],
      disconnected: false,
    };
    lastObserver = state;
    return {
      observe: (el: Element) => {
        state.observed.push(el);
      },
      disconnect: () => {
        state.disconnected = true;
      },
      unobserve: () => {},
    };
  };
}

function mountChrome(className: string, offsetHeight: number): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  setHeightFor(el, offsetHeight);
  document.body.appendChild(el);
  return el;
}

function setHeightFor(el: HTMLElement, offsetHeight: number) {
  Object.defineProperty(el, 'offsetHeight', {
    configurable: true,
    value: offsetHeight,
  });
}

function Probe({ onMeasure }: { onMeasure: (n: number) => void }) {
  const height = useTopChromeHeight();
  onMeasure(height);
  return null;
}

describe('useTopChromeHeight', () => {
  beforeEach(() => {
    lastObserver = null;
    vi.stubGlobal('ResizeObserver', makeMockRO());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('sums the app header and top toolbar heights on mount', () => {
    mountChrome('app-header', 56);
    mountChrome('list-toolbar list-toolbar--top', 44);
    const seen: number[] = [];
    render(<Probe onMeasure={(n) => seen.push(n)} />);
    expect(seen.at(-1)).toBe(100);
    // Both top strips are observed so a reflow (e.g. the toolbar wrapping) fires
    // the re-measure.
    expect(lastObserver!.observed).toContain(document.querySelector('.app-header'));
    expect(lastObserver!.observed).toContain(
      document.querySelector('.list-toolbar--top'),
    );
  });

  it('ignores the bottom toolbar — only the top one pins below the header', () => {
    mountChrome('app-header', 56);
    mountChrome('list-toolbar list-toolbar--top', 44);
    mountChrome('list-toolbar list-toolbar--bottom', 44);
    const seen: number[] = [];
    render(<Probe onMeasure={(n) => seen.push(n)} />);
    expect(seen.at(-1)).toBe(100);
  });

  it('re-measures when the toolbar wraps to a second row (ResizeObserver fires)', () => {
    mountChrome('app-header', 56);
    const toolbar = mountChrome('list-toolbar list-toolbar--top', 44);
    const seen: number[] = [];
    render(<Probe onMeasure={(n) => seen.push(n)} />);
    expect(seen.at(-1)).toBe(100);
    // Toolbar wraps to two 44px rows on a narrow phone: 44 → 88, no window resize.
    setHeightFor(toolbar, 88);
    act(() => {
      lastObserver!.callback();
    });
    expect(seen.at(-1)).toBe(144);
  });

  it('re-measures on window resize', () => {
    mountChrome('app-header', 56);
    const toolbar = mountChrome('list-toolbar list-toolbar--top', 44);
    const seen: number[] = [];
    render(<Probe onMeasure={(n) => seen.push(n)} />);
    setHeightFor(toolbar, 88);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(seen.at(-1)).toBe(144);
  });

  it('disconnects the observer on unmount', () => {
    mountChrome('app-header', 56);
    mountChrome('list-toolbar list-toolbar--top', 44);
    const { unmount } = render(<Probe onMeasure={() => {}} />);
    const obs = lastObserver!;
    unmount();
    expect(obs.disconnected).toBe(true);
  });

  it('falls back gracefully when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    mountChrome('app-header', 56);
    mountChrome('list-toolbar list-toolbar--top', 44);
    const seen: number[] = [];
    expect(() => {
      render(<Probe onMeasure={(n) => seen.push(n)} />);
    }).not.toThrow();
    expect(seen.at(-1)).toBe(100);
  });
});
