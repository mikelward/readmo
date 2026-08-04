import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetNetworkStatusForTests } from '../lib/networkStatus';
import { useStateSync } from './useStateSync';

function StateSyncMount() {
  useStateSync();
  return null;
}

/** Drive document.visibilityState in jsdom (it has no setter by default). */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

/** Drive navigator.onLine in jsdom (also read-only by default). */
function setOnLine(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

describe('useStateSync', () => {
  afterEach(() => {
    setVisibility('visible');
    // Bring the device back online before resetting the tracker, so React
    // Query's singleton onlineManager isn't left paused for later tests.
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    _resetNetworkStatusForTests();
    vi.restoreAllMocks();
  });

  it('re-pulls state when the window regains focus', () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const resync = vi.spyOn(source, 'resyncState');
    renderWithProviders(<StateSyncMount />, { source });

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('re-pulls state when the tab becomes visible', () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const resync = vi.spyOn(source, 'resyncState');
    renderWithProviders(<StateSyncMount />, { source });

    act(() => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('re-pulls state when the device comes back online', () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const resync = vi.spyOn(source, 'resyncState');
    renderWithProviders(<StateSyncMount />, { source });

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('does not re-pull on a focus event while the tab is still hidden', () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const resync = vi.spyOn(source, 'resyncState');
    renderWithProviders(<StateSyncMount />, { source });

    act(() => {
      setVisibility('hidden');
      window.dispatchEvent(new Event('focus'));
    });
    expect(resync).not.toHaveBeenCalled();
  });

  it('does not re-pull on focus while the device reports no network', () => {
    // Returning to a disconnected tab shouldn't start a read that can only
    // fail — on its own clock, up to the 8s read cap.
    const source = new MockDataSource(`test-${Math.random()}`);
    const resync = vi.spyOn(source, 'resyncState');
    renderWithProviders(<StateSyncMount />, { source });

    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(resync).not.toHaveBeenCalled();
  });

  it('re-pulls on the reconnect that ends an offline stretch', () => {
    // The guard must not swallow the one trigger that matters while offline.
    // networkStatus registers its own `online` listener at module load — before
    // this hook mounts — so the device signal is already back to online by the
    // time our listener runs.
    const source = new MockDataSource(`test-${Math.random()}`);
    const resync = vi.spyOn(source, 'resyncState');
    renderWithProviders(<StateSyncMount />, { source });

    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('stops listening after unmount', () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const resync = vi.spyOn(source, 'resyncState');
    const { unmount } = renderWithProviders(<StateSyncMount />, { source });

    unmount();
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    expect(resync).not.toHaveBeenCalled();
  });
});
