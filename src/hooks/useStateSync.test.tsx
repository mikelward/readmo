import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
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

describe('useStateSync', () => {
  afterEach(() => {
    setVisibility('visible');
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
