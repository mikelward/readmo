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
import {
  AUTO_SUMMARIZE_PINNED_KEY,
  resetReadingPrefsCacheForTest,
} from './useReadingPrefs';
import { summaryQueryKey } from './useSummary';
import { CAPABILITIES_QUERY_KEY } from './useCapabilities';
import type { SummaryResult } from '../lib/summary';
import type { Capabilities } from '../lib/data/DataSource';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

// The prewarm gates on useFullTextAllowed, which is now closed until capabilities
// resolve to allowed (a signed-out caller is never allowlisted). Seed a disarmed
// (open-to-all) capability set so these tests exercise the allowed path.
const ALLOWED_CAPS: Capabilities = { family: false, admin: false, allowlistArmed: false };
function seedAllowed(qc: QueryClient) {
  qc.setQueryData(CAPABILITIES_QUERY_KEY, ALLOWED_CAPS);
}

afterEach(() => {
  setNavigatorOnline(true);
  _resetNetworkStatusForTests();
  window.localStorage.removeItem('readmo:mock-signed-in');
  window.localStorage.removeItem(AUTO_SUMMARIZE_PINNED_KEY);
  resetReadingPrefsCacheForTest();
});

function Harness() {
  useSummaryPrewarm();
  return null;
}

function setup(source: MockDataSource) {
  const queryClient = new QueryClient();
  seedAllowed(queryClient);
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

  it('does not warm when "Auto generate summaries for pinned articles" is off', async () => {
    window.localStorage.setItem(AUTO_SUMMARIZE_PINNED_KEY, '0');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getSummary');
    const qc = setup(source);

    source.stateStore.set(ID, 'pinned', true);
    await Promise.resolve();
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
    expect(qc.getQueryData(summaryQueryKey(ID))).toBeUndefined();
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
    seedAllowed(queryClient);

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

  it('does not refetch an unsettled summary on unrelated state emits', async () => {
    // A summary stuck on a transient `unreachable` is intentionally left
    // unwarmed; an unrelated emit (favoriting a different item) must not retry
    // it — only reconnect / gate-resolve should. Guards against per-emit
    // amplification during a Gemini/Jina outage.
    class FlakySummary extends MockDataSource {
      summaryCalls = 0;
      async getSummary(): Promise<SummaryResult> {
        this.summaryCalls += 1;
        return { status: 'unreachable', summary: null };
      }
    }
    const source = new FlakySummary(`test-${Math.random()}`);
    setup(source);

    source.stateStore.set(ID, 'pinned', true);
    await waitFor(() => expect(source.summaryCalls).toBe(1));

    source.stateStore.set('item-2', 'favorite', true);
    await Promise.resolve();
    await Promise.resolve();
    expect(source.summaryCalls).toBe(1);
  });

  it('re-warms a pin that failed transiently when the app returns to the foreground', async () => {
    // A pinned summary whose warm hit a transient failure while the app stayed
    // online (no connectivity change) is left unwarmed. Returning to the app
    // (window focus) is a bounded retry boundary that must pick it back up —
    // unlike an unrelated state emit (previous test), which must NOT.
    class FlakyOnce extends MockDataSource {
      summaryCalls = 0;
      async getSummary(): Promise<SummaryResult> {
        this.summaryCalls += 1;
        return this.summaryCalls === 1
          ? { status: 'unreachable', summary: null }
          : { status: 'ok', summary: 'Recovered on foreground.' };
      }
    }
    const source = new FlakyOnce(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set(ID, 'pinned', true);
    await waitFor(() => expect(source.summaryCalls).toBe(1));
    expect(qc.getQueryData(summaryQueryKey(ID))).toMatchObject({ status: 'unreachable' });

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect(qc.getQueryData(summaryQueryKey(ID))).toMatchObject({ status: 'ok' }),
    );
    expect(source.summaryCalls).toBe(2);
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
