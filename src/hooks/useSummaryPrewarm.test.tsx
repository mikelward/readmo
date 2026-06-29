import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import {
  IsRestoringProvider,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetNetworkStatusForTests } from '../lib/networkStatus';
import { useSummaryPrewarm } from './useSummaryPrewarm';
import { summaryQueryKey } from './useSummary';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

afterEach(() => {
  setNavigatorOnline(true);
  _resetNetworkStatusForTests();
  window.localStorage.removeItem('readmo:mock-signed-in');
});

function Harness() {
  useSummaryPrewarm();
  return null;
}

function setup(source: MockDataSource) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <DataSourceProvider source={source}>
        <Harness />
      </DataSourceProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

// Seeded item ids the MockDataSource knows about (`item-${i+1}`), so getSummary
// resolves `ok`.
const ID = 'item-1';

describe('useSummaryPrewarm', () => {
  it('pre-warms the summary into the cache when an item is pinned this session', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set(ID, 'pinned', true);

    await waitFor(() =>
      expect(qc.getQueryData(summaryQueryKey(ID))).toMatchObject({ status: 'ok' }),
    );
  });

  it('warms an item already pinned on mount (boot / cross-device synced pin)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    // Pin BEFORE the hook mounts — the same shape as a pin restored on boot or
    // hydrated from another device. It must warm too (cheap: server-cached).
    source.stateStore.set(ID, 'pinned', true);

    const qc = setup(source);

    await waitFor(() =>
      expect(qc.getQueryData(summaryQueryKey(ID))).toMatchObject({ status: 'ok' }),
    );
  });

  it('does not warm a favorite-only item (summary is a pinned-list feature)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getSummary');
    const qc = setup(source);

    source.stateStore.set(ID, 'favorite', true);
    await Promise.resolve();
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
    expect(qc.getQueryData(summaryQueryKey(ID))).toBeUndefined();
  });

  it('does not warm while offline, then warms on reconnect', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    setNavigatorOnline(false);
    _resetNetworkStatusForTests();
    const qc = setup(source);

    source.stateStore.set(ID, 'pinned', true);
    await Promise.resolve();
    expect(qc.getQueryData(summaryQueryKey(ID))).toBeUndefined();

    // Reconnect → the online effect retries the still-pinned, unwarmed item.
    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() =>
      expect(qc.getQueryData(summaryQueryKey(ID))).toMatchObject({ status: 'ok' }),
    );
  });

  it('defers warming until the persisted cache has restored', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set(ID, 'pinned', true);
    const spy = vi.spyOn(source, 'getSummary');
    const queryClient = new QueryClient();

    const tree = (restoring: boolean) => (
      <QueryClientProvider client={queryClient}>
        <IsRestoringProvider value={restoring}>
          <DataSourceProvider source={source}>
            <Harness />
          </DataSourceProvider>
        </IsRestoringProvider>
      </QueryClientProvider>
    );

    const { rerender } = render(tree(true));
    await Promise.resolve();
    await Promise.resolve();
    // While restoring, prefetching against the not-yet-hydrated cache is held off.
    expect(spy).not.toHaveBeenCalled();

    // Restore completes → the pinned set is warmed.
    rerender(tree(false));
    await waitFor(() =>
      expect(queryClient.getQueryData(summaryQueryKey(ID))).toMatchObject({ status: 'ok' }),
    );
  });

  it('does not re-call once a terminal summary is cached (generate-once)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set(ID, 'pinned', true);
    await waitFor(() =>
      expect(qc.getQueryData(summaryQueryKey(ID))).toMatchObject({ status: 'ok' }),
    );

    const spy = vi.spyOn(source, 'getSummary');
    // Unpin then re-pin in the same session: the cached terminal `ok` is
    // Infinity-stale, so prefetch is a no-op — no second Gemini call.
    source.stateStore.set(ID, 'pinned', false);
    source.stateStore.set(ID, 'pinned', true);
    await Promise.resolve();
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
  });
});
