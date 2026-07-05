import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
