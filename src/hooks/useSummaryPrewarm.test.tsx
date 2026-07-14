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

  it('keeps retrying a pin whose summary is not ready yet, until it settles', async () => {
    // The durability fix: after a pin, the server may still be generating the
    // summary in the background (the pin trigger downloads the full article
    // first). The warm keeps polling on a bounded backoff — no external trigger
    // needed — so the summary lands in the cache (durable offline) once ready.
    vi.useFakeTimers();
    try {
      class NotReadyThenOk extends MockDataSource {
        summaryCalls = 0;
        async getSummary(): Promise<SummaryResult> {
          this.summaryCalls += 1;
          // Not ready on the first two tries, then the background generation
          // completes and the fetch returns the summary.
          return this.summaryCalls < 3
            ? { status: 'unreachable', summary: null }
            : { status: 'ok', summary: 'Ready now.' };
        }
      }
      const source = new NotReadyThenOk(`test-${Math.random()}`);
      const qc = setup(source);

      source.stateStore.set(ID, 'pinned', true);
      // First (immediate) attempt — still generating.
      await vi.advanceTimersByTimeAsync(0);
      expect(source.summaryCalls).toBe(1);

      // Backoff #1 (~2 s) → second attempt, still not ready.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(source.summaryCalls).toBe(2);

      // Backoff #2 (~4 s) → third attempt succeeds and settles into the cache.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(source.summaryCalls).toBe(3);
      expect(qc.getQueryData(summaryQueryKey(ID))).toMatchObject({ status: 'ok' });

      // Settled → the loop stops; no further polling.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(source.summaryCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never gives up on an unsettled pin: backs off to the delay ceiling and keeps polling', async () => {
    // A pin is a promise that the summary will be on-device. The backoff caps
    // its DELAY (60 s), not its attempts — a chain that stopped after N tries
    // left the pin cold in exactly the case the user notices (opening it after
    // an outage clears). At the ceiling this is one tiny request per minute per
    // unsettled pin, only while the app is open.
    vi.useFakeTimers();
    try {
      class AlwaysDown extends MockDataSource {
        summaryCalls = 0;
        async getSummary(): Promise<SummaryResult> {
          this.summaryCalls += 1;
          return { status: 'unreachable', summary: null };
        }
      }
      const source = new AlwaysDown(`test-${Math.random()}`);
      setup(source);

      source.stateStore.set(ID, 'pinned', true);
      // Attempts land at t ≈ 0, 2, 6, 14, 30, 62, 122, 182 s (delays 2, 4, 8,
      // 16, 32, then the 60 s ceiling).
      await vi.advanceTimersByTimeAsync(200_000);
      expect(source.summaryCalls).toBe(8);

      // Well past the old 6-attempt ceiling it is STILL polling, one per minute.
      await vi.advanceTimersByTimeAsync(180_000);
      expect(source.summaryCalls).toBe(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles on a non-retryable `unavailable` (key unset) — no endless polling', async () => {
    // The server marks the not-configured `unavailable` NON-retryable (polling
    // can't set an API key), and the client honors that: one attempt, settled,
    // chain stops. Without this, an unconfigured deployment would have every
    // pinned item hitting the Edge Function once a minute forever.
    vi.useFakeTimers();
    try {
      class KeyUnset extends MockDataSource {
        summaryCalls = 0;
        async getSummary(): Promise<SummaryResult> {
          this.summaryCalls += 1;
          return { status: 'unavailable', summary: null };
        }
      }
      const source = new KeyUnset(`test-${Math.random()}`);
      setup(source);

      source.stateStore.set(ID, 'pinned', true);
      await vi.advanceTimersByTimeAsync(400_000);
      expect(source.summaryCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps re-checking an `unavailable` still flagged retryable (older backend)', async () => {
    // Backwards compat (guardrail #11): a not-yet-redeployed backend still ships
    // `unavailable` with `retryable: true`; the client keeps its old re-check
    // behavior for that shape rather than freezing it as terminal.
    vi.useFakeTimers();
    try {
      class OldBackend extends MockDataSource {
        summaryCalls = 0;
        async getSummary(): Promise<SummaryResult> {
          this.summaryCalls += 1;
          return { status: 'unavailable', summary: null, retryable: true };
        }
      }
      const source = new OldBackend(`test-${Math.random()}`);
      setup(source);

      source.stateStore.set(ID, 'pinned', true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(source.summaryCalls).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a stuck in-flight fetch on return to foreground and refetches fresh', async () => {
    // A fetch that was in flight when the app was suspended can be a corpse
    // that never settles after resume — and React Query dedupes any later
    // prefetch into it, so without the cancel the foreground rewarm (and the
    // reader's own open) would silently join the dead fetch. The
    // hidden→visible handler must cancel it and issue a genuinely new request.
    class HangsFirst extends MockDataSource {
      summaryCalls = 0;
      async getSummary(): Promise<SummaryResult> {
        this.summaryCalls += 1;
        if (this.summaryCalls === 1) return new Promise<never>(() => {}); // frozen
        return { status: 'ok', summary: 'Fresh after resume.' };
      }
    }
    const source = new HangsFirst(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set(ID, 'pinned', true);
    await waitFor(() => expect(source.summaryCalls).toBe(1));

    // Return to the foreground (jsdom's visibilityState is 'visible').
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() =>
      expect(qc.getQueryData(summaryQueryKey(ID))).toMatchObject({ status: 'ok' }),
    );
    expect(source.summaryCalls).toBe(2);
  });

  it('cancels a pending retry when the item is unpinned', async () => {
    vi.useFakeTimers();
    try {
      class AlwaysDown extends MockDataSource {
        summaryCalls = 0;
        async getSummary(): Promise<SummaryResult> {
          this.summaryCalls += 1;
          return { status: 'unreachable', summary: null };
        }
      }
      const source = new AlwaysDown(`test-${Math.random()}`);
      setup(source);

      source.stateStore.set(ID, 'pinned', true);
      await vi.advanceTimersByTimeAsync(0);
      expect(source.summaryCalls).toBe(1);

      // Unpin before the first backoff fires → the chain is cancelled.
      source.stateStore.set(ID, 'pinned', false);
      await vi.advanceTimersByTimeAsync(200_000);
      expect(source.summaryCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
