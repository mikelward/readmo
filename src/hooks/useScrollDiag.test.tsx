import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import { clearDiag, getDiagBuffer, getDiagReport } from '../lib/scrollDiag';
import { useScrollDiag } from './useScrollDiag';

function Harness({ enabled }: { enabled: boolean }) {
  useScrollDiag(enabled);
  return null;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderDiag(enabled: boolean, source: MockDataSource) {
  return render(
    <DataSourceProvider source={source}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Harness enabled={enabled} />
          <LocationProbe />
          <Routes>
            <Route path="/" element={null} />
            <Route path="/debug/scroll" element={<div>diag page</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </DataSourceProvider>,
  );
}

function setScrollY(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

// The max scrollable offset the sampler computes for a given document height.
function maxOf(scrollHeight: number) {
  return Math.max(0, scrollHeight - window.innerHeight);
}

describe('useScrollDiag', () => {
  let source: MockDataSource;

  beforeEach(() => {
    clearDiag();
    setScrollY(0);
    source = new MockDataSource(`diag-${Math.random()}`);
  });

  afterEach(() => {
    clearDiag();
    setScrollY(0);
    vi.useRealTimers();
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 0,
      configurable: true,
    });
  });

  it('records a Done flip and shows a sticky "Done — Report bug" toast', () => {
    renderDiag(true, source);
    setScrollY(1200);
    act(() => source.stateStore.hide('item-1'));

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Report bug' }),
    ).toBeInTheDocument();
    const buf = getDiagBuffer();
    expect(buf.at(-1)).toMatchObject({ kind: 'done', y: 1200, id: 'item-1' });
  });

  it('captures the dismissed row headline when it is in the DOM', () => {
    render(
      <DataSourceProvider source={source}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/']}>
            <Harness enabled={true} />
            <ul>
              <li data-item-id="item-1">
                <span className="item-row__title-text">Big News</span>
              </li>
            </ul>
          </MemoryRouter>
        </ToastProvider>
      </DataSourceProvider>,
    );
    act(() => source.stateStore.hide('item-1'));
    expect(getDiagBuffer().at(-1)).toMatchObject({
      kind: 'done',
      id: 'item-1',
      title: 'Big News',
    });
  });

  it('samples document height and records a resize when it collapses without a scroll', () => {
    vi.useFakeTimers();
    const setHeight = (h: number) =>
      Object.defineProperty(document.documentElement, 'scrollHeight', {
        value: h,
        configurable: true,
      });
    setHeight(2000); // max = 2000 − innerHeight
    renderDiag(true, source);
    const before = maxOf(2000);
    // The document collapses (e.g. a background resync reshaping the list) with
    // no scroll event — the sampler should still catch it.
    setHeight(1000);
    act(() => vi.advanceTimersByTime(200));

    const resize = getDiagBuffer().find((e) => e.kind === 'resize');
    expect(resize).toBeTruthy();
    expect(resize?.max).toBe(maxOf(1000));
    expect(resize?.delta).toBe(maxOf(1000) - before);
    vi.useRealTimers();
  });

  it('records the layout breakdown on a Done and probes the frames after it', () => {
    // Drive requestAnimationFrame by hand so the post-Done probe burst is
    // deterministic (each tick reschedules the next; shifting the queue runs
    // them in order).
    const rafQueue: FrameRequestCallback[] = [];
    let nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return nextId++;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const flushFrames = (n: number) => {
      for (let i = 0; i < n && rafQueue.length > 0; i += 1) rafQueue.shift()!(0);
    };

    render(
      <DataSourceProvider source={source}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/']}>
            <Harness enabled={true} />
            <div className="item-list__body" data-testid="body" />
            <ul>
              <li data-item-id="a" />
              <li data-item-id="b" />
            </ul>
          </MemoryRouter>
        </ToastProvider>
      </DataSourceProvider>,
    );
    const body = screen.getByTestId('body');
    // Model the momentary collapse: the body is tall at the Done, dips short for
    // a couple of frames, then recovers — with the row count never changing.
    let bodyH = 1600;
    Object.defineProperty(body, 'offsetHeight', {
      configurable: true,
      get: () => bodyH,
    });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      get: () => bodyH + 100,
    });

    act(() => source.stateStore.hide('a'));
    // The Done row captured the tall, pre-collapse layout.
    expect(getDiagBuffer().find((e) => e.kind === 'done')).toMatchObject({
      bodyH: 1600,
      docH: 1700,
      rows: 2,
    });

    // Collapse for the first frames, then recover while the burst runs.
    bodyH = 800;
    flushFrames(2);
    bodyH = 1600;
    flushFrames(12);

    const probes = getDiagBuffer().filter((e) => e.kind === 'probe');
    expect(probes.length).toBeGreaterThan(0);
    // The burst caught the dip's floor...
    expect(Math.min(...probes.map((p) => p.bodyH ?? Infinity))).toBe(800);
    // ...and no rows left mid-dip — it's a reflow, not a removal.
    expect(probes.every((p) => p.rows === 2)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('records window scroll positions with deltas', () => {
    renderDiag(true, source);
    setScrollY(800);
    act(() => window.dispatchEvent(new Event('scroll')));
    setScrollY(0);
    act(() => window.dispatchEvent(new Event('scroll')));

    const scrolls = getDiagBuffer().filter((e) => e.kind === 'scroll');
    expect(scrolls).toHaveLength(2);
    expect(scrolls[0]).toMatchObject({ y: 800, delta: 800 });
    // The jump toward the top shows as a negative delta.
    expect(scrolls[1]).toMatchObject({ y: 0, delta: -800 });
  });

  it('freezes the report and navigates to /debug/scroll on Report bug', () => {
    renderDiag(true, source);
    setScrollY(600);
    act(() => window.dispatchEvent(new Event('scroll')));
    act(() => source.stateStore.hide('item-1'));

    expect(getDiagReport()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));

    expect(getDiagReport()).not.toBeNull();
    expect(screen.getByTestId('loc')).toHaveTextContent('/debug/scroll');
  });

  it('is a no-op when disabled — no listener, no toast, no recording', () => {
    renderDiag(false, source);
    setScrollY(500);
    act(() => window.dispatchEvent(new Event('scroll')));
    act(() => source.stateStore.hide('item-1'));

    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(getDiagBuffer()).toHaveLength(0);
  });
});
