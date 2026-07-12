import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import type { ItemId } from '../lib/types';
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

  it('shrinks the observer root by both the top and bottom sticky insets, less the edge slack', () => {
    mountSticky('app-header', 56);
    mountSticky('list-toolbar', 104); // top chrome bottom = 104
    mountSticky('list-toolbar list-toolbar--bottom', 768); // pinned, height 48
    render(<Probe />);
    // Each occluding inset is pulled in by SWEEP_EDGE_SLACK_PX (2) so a row
    // tucked a hair behind the chrome still counts as fully visible and sweeps —
    // the "sometimes one row left after a group Sweep" fix.
    expect(lastInit?.rootMargin).toBe('-102px 0px -46px 0px');
  });

  it('observes the fully-visible cutoff as a threshold so it fires on crossings', () => {
    // The predicate treats ratio >= 0.999 as visible; the observer must watch
    // that same value, or a row dropping from ~0.9995 to behind the chrome
    // would never get a follow-up callback (no [0, 1] boundary is crossed).
    mountSticky('app-header', 56);
    render(<Probe />);
    expect(lastInit?.threshold).toEqual([0, 0.999, 1]);
  });

  it('clamps a chrome inset smaller than the slack to zero, never negative', () => {
    // A 1px chrome bottom minus the 2px slack must floor at 0, not -1 (a
    // positive rootMargin would *grow* the root past the viewport).
    mountSticky('app-header', 1);
    render(<Probe />);
    expect(lastInit?.rootMargin).toBe('-0px 0px -0px 0px');
  });

  it('uses a zero bottom margin when no bottom toolbar is pinned', () => {
    mountSticky('app-header', 56);
    mountSticky('list-toolbar', 104);
    render(<Probe />);
    // Top inset gets the slack; the bare viewport edge (bottom inset 0) does
    // NOT — a row genuinely cut off by the screen edge must stay excluded.
    expect(lastInit?.rootMargin).toBe('-102px 0px -0px 0px');
  });

  it('extends the top inset by a pinned group-by-feed section header', () => {
    // In group-by-feed, the pinned section header paints over rows below the
    // chrome, so the visibility boundary — and auto-hide-on-scroll's top exit —
    // is the header's bottom, not the toolbar's. The top inset grows by the
    // header height (48), then the 2px slack applies: 104 + 48 - 2 = 150.
    mountSticky('app-header', 56);
    mountSticky('list-toolbar', 104);
    mountSticky('item-list__group-header', 152); // height 48
    render(<Probe />);
    expect(lastInit?.rootMargin).toBe('-150px 0px -0px 0px');
  });
});

// onExitTop fires when a previously-seen row scrolls fully off the *top* — the
// signal that drives auto-hide-on-scroll. The detection lives in the observer
// callback, so the harness captures it and replays entries with the geometry a
// real IntersectionObserver would report.
describe('useInViewIds onExitTop', () => {
  let capturedCb: IntersectionObserverCallback | null = null;

  beforeEach(() => {
    capturedCb = null;
    class CapturingIO {
      constructor(cb: IntersectionObserverCallback) {
        capturedCb = cb;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', CapturingIO);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function Rows({ onExitTop }: { onExitTop: (ids: ItemId[]) => void }) {
    const { getRowRef } = useInViewIds({ onExitTop });
    return (
      <ul>
        {['a', 'b', 'c'].map((id) => (
          <li key={id} data-item-id={id} ref={getRowRef(id)} />
        ))}
      </ul>
    );
  }

  // A single row whose presence in the DOM the test toggles, to exercise the
  // unmount → remount (Undo-restore) path.
  function ToggleRow({
    onExitTop,
    present,
  }: {
    onExitTop: (ids: ItemId[]) => void;
    present: boolean;
  }) {
    const { getRowRef } = useInViewIds({ onExitTop });
    return <ul>{present ? <li data-item-id="a" ref={getRowRef('a')} /> : null}</ul>;
  }

  function entryFor(
    id: string,
    ratio: number,
    geom?: { rectBottom?: number; rootTop?: number },
  ): IntersectionObserverEntry {
    const el = document.querySelector(`[data-item-id="${id}"]`) as Element;
    const rootBounds =
      geom?.rootTop === undefined
        ? null
        : ({ top: geom.rootTop } as DOMRectReadOnly);
    return {
      target: el,
      intersectionRatio: ratio,
      isIntersecting: ratio > 0,
      boundingClientRect: { bottom: geom?.rectBottom ?? 0 } as DOMRectReadOnly,
      intersectionRect: {} as DOMRectReadOnly,
      rootBounds,
      time: 0,
    };
  }

  function fire(...entries: IntersectionObserverEntry[]): void {
    act(() => {
      capturedCb?.(entries, {} as IntersectionObserver);
    });
  }

  it('reports a seen row that scrolls off the top', () => {
    const seen: ItemId[][] = [];
    render(<Rows onExitTop={(ids) => seen.push(ids)} />);
    // The row was fully visible, then dropped fully out of view above the root.
    fire(entryFor('a', 1));
    fire(entryFor('a', 0, { rectBottom: 50, rootTop: 100 }));
    expect(seen).toEqual([['a']]);
  });

  it('does not report a row that was never fully visible (below the fold)', () => {
    const seen: ItemId[][] = [];
    render(<Rows onExitTop={(ids) => seen.push(ids)} />);
    // Row 'b' never reached full visibility before going to ratio 0.
    fire(entryFor('b', 0, { rectBottom: 900, rootTop: 100 }));
    expect(seen).toEqual([]);
  });

  it('does not report a seen row that exits via the bottom (scrolled back up)', () => {
    const seen: ItemId[][] = [];
    render(<Rows onExitTop={(ids) => seen.push(ids)} />);
    fire(entryFor('c', 1));
    // Now fully below the root's top edge (rect bottom is far past it).
    fire(entryFor('c', 0, { rectBottom: 900, rootTop: 100 }));
    expect(seen).toEqual([]);
  });

  it('treats absent rootBounds as a top exit (jsdom fallback)', () => {
    const seen: ItemId[][] = [];
    render(<Rows onExitTop={(ids) => seen.push(ids)} />);
    fire(entryFor('a', 1));
    fire(entryFor('a', 0)); // rootBounds null
    expect(seen).toEqual([['a']]);
  });

  it('does not re-report a restored row remounted above the viewport (Undo)', () => {
    const seen: ItemId[][] = [];
    const { rerender } = render(
      <ToggleRow present onExitTop={(ids) => seen.push(ids)} />,
    );
    // Seen, then scrolled off the top → reported and (in the app) hidden.
    fire(entryFor('a', 1));
    fire(entryFor('a', 0, { rectBottom: 50, rootTop: 100 }));
    expect(seen).toEqual([['a']]);

    // The hide unmounts the row; Undo restores it, remounting above the
    // viewport so its first observation is non-intersecting at the top.
    rerender(<ToggleRow present={false} onExitTop={(ids) => seen.push(ids)} />);
    rerender(<ToggleRow present onExitTop={(ids) => seen.push(ids)} />);
    fire(entryFor('a', 0, { rectBottom: 50, rootTop: 100 }));

    // It must NOT be auto-hidden again — Undo would otherwise be unusable.
    expect(seen).toEqual([['a']]);
  });

  function EnablableRow({
    on,
    onExit,
  }: {
    on: boolean;
    onExit: (ids: ItemId[]) => void;
  }) {
    const { getRowRef } = useInViewIds({ onExitTop: on ? onExit : undefined });
    return (
      <ul>
        <li data-item-id="a" ref={getRowRef('a')} />
      </ul>
    );
  }

  it('does not report a row already scrolled past while the feature was off', () => {
    const seen: ItemId[][] = [];
    const onExit = (ids: ItemId[]) => seen.push(ids);
    const { rerender } = render(<EnablableRow on={false} onExit={onExit} />);
    // Visible, then scrolled off the top — all while OFF, so it ends up above the
    // viewport (out of inViewIds) and was never tracked as seen.
    fire(entryFor('a', 1));
    fire(entryFor('a', 0, { rectBottom: 50, rootTop: 100 }));
    // Enable: seeding from inViewIds excludes the already-passed row.
    rerender(<EnablableRow on onExit={onExit} />);
    // Replay its top-exit (as an observer recreation would): not reported.
    fire(entryFor('a', 0, { rectBottom: 50, rootTop: 100 }));
    expect(seen).toEqual([]);
  });

  // One observer callback can deliver SEVERAL records for the same row (one
  // per observation frame) when delivery lags a busy main thread — ordered
  // oldest→newest. Only the newest record reflects the row's current state.
  describe('multiple records for one row in a single batch', () => {
    function ViewProbe({
      onIds,
    }: {
      onIds: (ids: ReadonlySet<ItemId>) => void;
    }) {
      const { inViewIds, getRowRef } = useInViewIds();
      // Report the latest value through a callback from an effect, rather than
      // mutating a caller-owned box (a prop is immutable to the component).
      useEffect(() => {
        onIds(inViewIds);
      }, [onIds, inViewIds]);
      return (
        <ul>
          <li data-item-id="a" ref={getRowRef('a')} />
        </ul>
      );
    }

    it('keeps a row in view when the newest record says fully visible', () => {
      const out = { current: new Set<ItemId>() as ReadonlySet<ItemId> };
      render(<ViewProbe onIds={(ids) => (out.current = ids)} />);
      // Entered partially (older record), then crossed to fully visible
      // (newer record) — both delivered in one lagged batch. The stale
      // partial record must not override the newer fully-visible one, or the
      // row sits on screen unswept with no follow-up callback to fix it.
      fire(entryFor('a', 0.4), entryFor('a', 1));
      expect(out.current.has('a')).toBe(true);
    });

    it('drops a row when the newest record says no longer fully visible', () => {
      const out = { current: new Set<ItemId>() as ReadonlySet<ItemId> };
      render(<ViewProbe onIds={(ids) => (out.current = ids)} />);
      fire(entryFor('a', 1), entryFor('a', 0.4));
      expect(out.current.has('a')).toBe(false);
    });

    it('auto-hides a row fully seen and top-exited within one lagged batch', () => {
      const seen: ItemId[][] = [];
      render(<Rows onExitTop={(ids) => seen.push(ids)} />);
      // A never-before-seen row becomes fully visible and scrolls off the top
      // before the batch is delivered: the intermediate fully-visible record
      // must still mark it seen, so the final top-exit reports it.
      fire(entryFor('a', 1), entryFor('a', 0, { rectBottom: 50, rootTop: 100 }));
      expect(seen).toEqual([['a']]);
    });

    it('suppresses a top-exit that a newer reentry in the same batch reversed', () => {
      const seen: ItemId[][] = [];
      render(<Rows onExitTop={(ids) => seen.push(ids)} />);
      fire(entryFor('a', 1));
      // Exited the top, then bounced back into view before the batch was
      // delivered: the row is on screen, so it must not be auto-hidden.
      fire(
        entryFor('a', 0, { rectBottom: 50, rootTop: 100 }),
        entryFor('a', 0.5, { rectBottom: 150, rootTop: 100 }),
      );
      expect(seen).toEqual([]);
    });
  });

  it('applies to a row already fully visible when the feature is enabled', () => {
    const seen: ItemId[][] = [];
    const onExit = (ids: ItemId[]) => seen.push(ids);
    const { rerender } = render(<EnablableRow on={false} onExit={onExit} />);
    // Fully visible at the moment the reader enables the feature.
    fire(entryFor('a', 1));
    rerender(<EnablableRow on onExit={onExit} />);
    // Scrolling it off the top now reports it — the setting applies to what's
    // already on screen.
    fire(entryFor('a', 0, { rectBottom: 50, rootTop: 100 }));
    expect(seen).toEqual([['a']]);
  });
});
