import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, IsRestoringProvider } from '@tanstack/react-query';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetNetworkStatusForTests } from '../lib/networkStatus';
import { useOfflineCacheLock } from './useOfflineCacheLock';
import type { Capabilities } from '../lib/data/DataSource';
import { AUTO_SUMMARIZE_PINNED_KEY } from '../lib/settingsSync';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

/** Counts getSummary calls so the summary-warm tests can assert the gates
 * (pinned-only, opt-out, allowlist) skip the Edge call entirely. */
class CountingSummary extends MockDataSource {
  summaryCalls = 0;
  async getSummary(id: string) {
    this.summaryCalls += 1;
    return super.getSummary(id);
  }
}

class CompleteFeedFullText extends MockDataSource {
  fullTextCalls = 0;
  async getItem(id: string) {
    const fi = await super.getItem(id);
    if (fi) {
      fi.item = { ...fi.item, contentHtml: `<p>${'Complete feed paragraph. '.repeat(40)}</p>` };
    }
    return fi;
  }
  async fetchFullText(id: string) {
    this.fullTextCalls += 1;
    return super.fetchFullText(id);
  }
}

afterEach(() => {
  setNavigatorOnline(true);
  _resetNetworkStatusForTests();
  window.localStorage.removeItem('readmo:mock-signed-in');
  window.localStorage.removeItem(AUTO_SUMMARIZE_PINNED_KEY);
});

function Harness() {
  useOfflineCacheLock();
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

describe('useOfflineCacheLock', () => {
  it('caches a pinned item detail + reading body, and evicts on unpin', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    // The detail and (truncated) full-text bodies are warmed into the cache.
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    await waitFor(() => expect(qc.getQueryData(['fulltext', 'item-1'])).toBeTruthy());

    source.stateStore.set('item-1', 'pinned', false);
    // Unpinning evicts both so unpinned bodies don't linger in the cache.
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeUndefined());
    expect(qc.getQueryData(['fulltext', 'item-1'])).toBeUndefined();
  });

  it('retains the AI summary for a pinned item (idle observer) and evicts it on unpin', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true); // pinned before mount → locked on the first sync
    // gcTime: 0 so an entry with NO observer is evicted immediately — the summary
    // survives ONLY because the lock holds an idle observer on ['summary', id].
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );
    // The lock/warm has established the observers (incl. the summary one).
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());

    // A summary seeded now (the reader's 0058 ride-along) is retained despite
    // gcTime: 0, because the idle observer keeps ['summary', id] alive.
    await act(async () => {
      qc.setQueryData(['summary', 'item-1'], { status: 'ok', summary: 'gist', viaRow: true });
    });
    expect(qc.getQueryData(['summary', 'item-1'])).toEqual({
      status: 'ok',
      summary: 'gist',
      viaRow: true,
    });

    // Unpinning releases the observer and evicts the summary alongside the body.
    await act(async () => {
      source.stateStore.set('item-1', 'pinned', false);
    });
    await waitFor(() => expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined());
  });

  it('keeps the cache when an unpinned item is still favorited', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    source.stateStore.set('item-1', 'favorite', true);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());

    // Unpin — still favorited, so it stays in the offline bucket and cached.
    source.stateStore.set('item-1', 'pinned', false);
    await Promise.resolve();
    expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy();

    // Unfavorite too — now in no bucket, so it's evicted.
    source.stateStore.set('item-1', 'favorite', false);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeUndefined());
  });

  it('caches a favorited (never-pinned) item', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);
    source.stateStore.set('item-3', 'favorite', true);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-3'])).toBeTruthy());
  });

  it('prefetches full text for pinned items even when the feed body looks complete', async () => {
    const source = new CompleteFeedFullText(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);

    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    await waitFor(() => expect(qc.getQueryData(['fulltext', 'item-1'])).toBeTruthy());
    expect(source.fullTextCalls).toBe(1);
  });

  it('does not prefetch full text for favorite-only items whose feed body looks complete', async () => {
    const source = new CompleteFeedFullText(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'favorite', true);

    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    expect(qc.getQueryData(['fulltext', 'item-1'])).toBeUndefined();
    expect(source.fullTextCalls).toBe(0);
  });

  it('warms a pinned item’s AI summary into the cache', async () => {
    // The reliability fix: the offline lock now FETCHES the summary for a pinned
    // item (not just retains it), so it's cached before the reader opens — no
    // on-open "Summarizing…".
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);
    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() =>
      expect(qc.getQueryData(['summary', 'item-1'])).toMatchObject({ status: 'ok' }),
    );
  });

  it('does not warm the summary for a favorite-only item (pinned-only)', async () => {
    // A favorite has no server-side pin trigger, so warming its summary would spend
    // a Gemini call the auto-summarize design keeps to pins. The detail still warms.
    const source = new CountingSummary(`test-${Math.random()}`);
    const qc = setup(source);
    source.stateStore.set('item-3', 'favorite', true);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-3'])).toBeTruthy());
    expect(source.summaryCalls).toBe(0);
    expect(qc.getQueryData(['summary', 'item-3'])).toBeUndefined();
  });

  it('does not warm the summary when the auto-summarize opt-out is off', async () => {
    // The family-only "Auto generate summaries for pinned articles" toggle, off.
    // Full text still warms (not gated on it); the summary warm is skipped.
    window.localStorage.setItem(AUTO_SUMMARIZE_PINNED_KEY, '0');
    const source = new CountingSummary(`test-${Math.random()}`);
    const qc = setup(source);
    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() => expect(qc.getQueryData(['fulltext', 'item-1'])).toBeTruthy());
    expect(source.summaryCalls).toBe(0);
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined();
  });

  it('skips the summary warm entirely for an off-allowlist user', async () => {
    // Armed allowlist, off-list → the summary Edge call is never issued (same gate
    // as the full-text warm), so a non-family user makes zero summary requests.
    const source = new CountingSummary(`test-${Math.random()}`);
    const qc = setup(source);
    qc.setQueryData(['capabilities'], { family: false, admin: false, allowlistArmed: true });
    source.stateStore.set('item-1', 'pinned', true);
    source.stateStore.set('item-2', 'pinned', true); // a second emit would re-warm
    await waitFor(() => expect(qc.getQueryData(['item', 'item-2'])).toBeTruthy());
    expect(source.summaryCalls).toBe(0);
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined();
  });

  it('warms an unsettled summary at most once — no per-emit Edge amplification', async () => {
    // A pinned item whose summary is unsettled (transient unreachable) must not
    // re-hit the summary Edge Function on every later state emit; the bounded
    // retry-until-settled belongs to useSummaryPrewarm, not this warm.
    class UnsettledSummary extends MockDataSource {
      summaryCalls = 0;
      async getSummary() {
        this.summaryCalls += 1;
        return { status: 'unreachable' as const, summary: null };
      }
    }
    const source = new UnsettledSummary(`test-${Math.random()}`);
    setup(source);
    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() => expect(source.summaryCalls).toBe(1));
    // Flush the prefetch's `.then` (summaryWarmed.add) before more emits.
    await act(async () => {
      await Promise.resolve();
    });
    // Further emits on the same pinned item must not re-issue getSummary.
    await act(async () => {
      source.stateStore.set('item-1', 'favorite', true);
      source.stateStore.set('item-1', 'opened', true);
      source.stateStore.set('item-1', 'favorite', false);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(source.summaryCalls).toBe(1);
  });

  it('warms a pin made while offline once connectivity returns', async () => {
    setNavigatorOnline(false);
    _resetNetworkStatusForTests();
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    // Offline: locked but nothing fetched yet.
    await Promise.resolve();
    expect(qc.getQueryData(['item', 'item-1'])).toBeUndefined();

    // Reconnect → the lock is warmed without re-toggling the pin.
    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    await waitFor(() => expect(qc.getQueryData(['fulltext', 'item-1'])).toBeTruthy());
  });

  it('retries a transient full-text miss instead of getting stuck on the stub', async () => {
    class FlakyFullText extends MockDataSource {
      ftCalls = 0;
      async fetchFullText(id: string) {
        this.ftCalls += 1;
        return this.ftCalls === 1
          ? ({ status: 'unreachable', contentHtml: null } as const)
          : super.fetchFullText(id);
      }
    }
    const source = new FlakyFullText(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    // First attempt: detail cached, full text transiently unreachable (not warmed).
    await waitFor(() =>
      expect(
        (qc.getQueryData(['fulltext', 'item-1']) as { status?: string } | undefined)?.status,
      ).toBe('unreachable'),
    );

    // A later sync pass (here: also favoriting it) retries the unwarmed id.
    source.stateStore.set('item-1', 'favorite', true);
    await waitFor(() =>
      expect(
        (qc.getQueryData(['fulltext', 'item-1']) as { status?: string } | undefined)?.status,
      ).toBe('ok'),
    );
  });

  it('keeps retrying a pinned full-text warm until the body settles', async () => {
    // Pinning should make the later reader open instant even if the server-side
    // pin trigger is still extracting the full article when the first client warm
    // checks. The warmer polls on a bounded backoff instead of waiting for an
    // unrelated state emit/reconnect.
    vi.useFakeTimers();
    try {
      class NotReadyThenFullText extends MockDataSource {
        ftCalls = 0;
        async fetchFullText(id: string) {
          this.ftCalls += 1;
          return this.ftCalls < 3
            ? ({ status: 'unreachable', contentHtml: null } as const)
            : super.fetchFullText(id);
        }
      }
      const source = new NotReadyThenFullText(`test-${Math.random()}`);
      const qc = setup(source);

      source.stateStore.set('item-1', 'pinned', true);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(source.ftCalls).toBe(1);
      expect(
        (qc.getQueryData(['fulltext', 'item-1']) as { status?: string } | undefined)?.status,
      ).toBe('unreachable');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(source.ftCalls).toBe(2);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(source.ftCalls).toBe(3);
      expect(
        (qc.getQueryData(['fulltext', 'item-1']) as { status?: string } | undefined)?.status,
      ).toBe('ok');

      await vi.advanceTimersByTimeAsync(120_000);
      expect(source.ftCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending pinned full-text retry when the item is unpinned', async () => {
    vi.useFakeTimers();
    try {
      class AlwaysUnreachableFullText extends MockDataSource {
        ftCalls = 0;
        async fetchFullText() {
          this.ftCalls += 1;
          return { status: 'unreachable', contentHtml: null } as const;
        }
      }
      const source = new AlwaysUnreachableFullText(`test-${Math.random()}`);
      setup(source);

      source.stateStore.set('item-1', 'pinned', true);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(source.ftCalls).toBe(1);

      source.stateStore.set('item-1', 'pinned', false);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(source.ftCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-prefetches a retryable allowlist denial after the gate later opens', async () => {
    // First pin: caller is off-allowlist → a `retryable` empty (silent denial).
    // It must NOT be marked warmed, so a later state-sync re-prefetches it once
    // the operator has added the caller and the function now returns the body.
    class GatedThenAllowed extends MockDataSource {
      ftCalls = 0;
      async fetchFullText(id: string) {
        this.ftCalls += 1;
        return this.ftCalls === 1
          ? ({ status: 'empty', contentHtml: null, retryable: true } as const)
          : super.fetchFullText(id);
      }
    }
    const source = new GatedThenAllowed(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() =>
      expect(
        (qc.getQueryData(['fulltext', 'item-1']) as { retryable?: boolean } | undefined)
          ?.retryable,
      ).toBe(true),
    );

    // A later sync pass retries the unwarmed id → now extracts the full body.
    source.stateStore.set('item-1', 'favorite', true);
    await waitFor(() =>
      expect(
        (qc.getQueryData(['fulltext', 'item-1']) as { status?: string } | undefined)?.status,
      ).toBe('ok'),
    );
  });

  it('skips the gated fulltext fetch entirely for an off-allowlist user', async () => {
    // When capabilities say the user can't use full text (allowlist armed, not
    // family), the warmer must mark the item warmed WITHOUT calling fulltext —
    // otherwise every item_state emit re-prefetches the same denial (the
    // request-amplification the reviewer flagged). Churn the store and assert
    // fetchFullText is never called.
    class CountingFullText extends MockDataSource {
      ftCalls = 0;
      async fetchFullText(id: string) {
        this.ftCalls += 1;
        return super.fetchFullText(id);
      }
    }
    const source = new CountingFullText(`test-${Math.random()}`);
    const qc = setup(source);
    qc.setQueryData(['capabilities'], {
      family: false,
      admin: false,
      allowlistArmed: true,
    });

    source.stateStore.set('item-1', 'pinned', true);
    source.stateStore.set('item-1', 'favorite', true); // a second emit would re-warm
    source.stateStore.set('item-2', 'pinned', true);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-2'])).toBeTruthy());

    expect(source.ftCalls).toBe(0);
    expect(qc.getQueryData(['fulltext', 'item-1'])).toBeUndefined();
  });

  it('re-warms a capability-gated item once membership flips to family', async () => {
    // A gate-skip marks the item warmed only to stop the off-list amplification —
    // NOT as a settled fetch. If the user is later added to the allowlist, the
    // capabilities query flips and the warmer must un-warm and fetch the body
    // instead of leaving the offline bucket stuck on the feed stub forever.
    class CountingFullText extends MockDataSource {
      ftCalls = 0;
      async fetchFullText(id: string) {
        this.ftCalls += 1;
        return super.fetchFullText(id);
      }
    }
    const source = new CountingFullText(`test-${Math.random()}`);
    const qc = setup(source);
    act(() => {
      qc.setQueryData(['capabilities'], {
        family: false,
        admin: false,
        allowlistArmed: true,
      });
    });

    source.stateStore.set('item-1', 'pinned', true);
    // Detail warms, but the gated full-text call is skipped entirely.
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    expect(source.ftCalls).toBe(0);
    expect(qc.getQueryData(['fulltext', 'item-1'])).toBeUndefined();

    // Operator adds the caller → capabilities flip to family → re-warm fires.
    act(() => {
      qc.setQueryData(['capabilities'], {
        family: true,
        admin: false,
        allowlistArmed: true,
      });
    });
    await waitFor(() => expect(qc.getQueryData(['fulltext', 'item-1'])).toBeTruthy());
    expect(source.ftCalls).toBeGreaterThan(0);
  });

  it('holds off the fulltext call while a signed-in user’s capabilities load', async () => {
    // Cold start: a signed-in user's capabilities haven't resolved yet. The
    // warmer must NOT fire fulltext on the unknown gate (an armed-allowlist
    // off-list user would otherwise get one Edge call per pinned item). Once
    // capabilities resolve to family, the held-off item warms.
    window.localStorage.setItem('readmo:mock-signed-in', '1');
    let resolveCaps!: (c: Capabilities) => void;
    class LoadingCaps extends MockDataSource {
      ftCalls = 0;
      getCapabilities(): Promise<Capabilities> {
        return new Promise<Capabilities>((r) => {
          resolveCaps = r;
        });
      }
      async fetchFullText(id: string) {
        this.ftCalls += 1;
        return super.fetchFullText(id);
      }
    }
    const source = new LoadingCaps(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    // Detail warms, but full text is held off while the gate is unknown.
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    expect(source.ftCalls).toBe(0);
    expect(qc.getQueryData(['fulltext', 'item-1'])).toBeUndefined();

    // Capabilities resolve to family → the held-off item now fetches its body.
    await act(async () => {
      resolveCaps({ family: true, admin: false, allowlistArmed: true });
    });
    await waitFor(() => expect(qc.getQueryData(['fulltext', 'item-1'])).toBeTruthy());
    expect(source.ftCalls).toBeGreaterThan(0);
  });

  it('holds off the fulltext call when a signed-in user’s capabilities error', async () => {
    // A `get_capabilities` failure ends with no data and fetchStatus 'idle' — that
    // must still read as "unknown gate" (held off), not "open", or an off-list
    // user resumes Edge calls after the error. Keyed on signed-in, not loading.
    window.localStorage.setItem('readmo:mock-signed-in', '1');
    class ErroringCaps extends MockDataSource {
      ftCalls = 0;
      async getCapabilities(): Promise<never> {
        throw new Error('capabilities unavailable');
      }
      async fetchFullText(id: string) {
        this.ftCalls += 1;
        return super.fetchFullText(id);
      }
    }
    const source = new ErroringCaps(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    source.stateStore.set('item-1', 'pinned', true);
    // Detail warms; the gate is unresolved (errored) → no fulltext call.
    await waitFor(() => expect(queryClient.getQueryData(['item', 'item-1'])).toBeTruthy());
    expect(source.ftCalls).toBe(0);
    expect(queryClient.getQueryData(['fulltext', 'item-1'])).toBeUndefined();
  });

  it('does not refetch the detail when a cached copy already exists (no boot burst)', async () => {
    class CountingSource extends MockDataSource {
      itemCalls: string[] = [];
      async getItem(id: string) {
        this.itemCalls.push(id);
        return super.getItem(id);
      }
    }
    const source = new CountingSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Pre-seed a hydrated detail, then bucket the item.
    const seed = new MockDataSource(`seed-${Math.random()}`);
    queryClient.setQueryData(['item', 'item-1'], await seed.getItem('item-1'));
    source.stateStore.set('item-1', 'pinned', true);

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    await Promise.resolve();
    await Promise.resolve();
    // The hydrated detail is treated as fresh → no network getItem for it.
    expect(source.itemCalls).not.toContain('item-1');
  });

  it('refreshes the /offline list when it newly caches an item', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() => expect(queryClient.getQueryData(['item', 'item-1'])).toBeTruthy());
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['offline'] }),
    );
  });

  it('does not refresh the /offline list when the item was already cached', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seed = new MockDataSource(`seed-${Math.random()}`);
    queryClient.setQueryData(['item', 'item-1'], await seed.getItem('item-1'));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    source.stateStore.set('item-1', 'pinned', true);
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['offline'] }),
    );
  });

  it('defers warming until the persisted cache has restored', async () => {
    class CountingSource extends MockDataSource {
      itemCalls: string[] = [];
      async getItem(id: string) {
        this.itemCalls.push(id);
        return super.getItem(id);
      }
    }
    const source = new CountingSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    source.stateStore.set('item-1', 'pinned', true);

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
    // While restoring, warming is deferred — no network getItem yet.
    expect(source.itemCalls).not.toContain('item-1');

    // Restore completes → the item is warmed.
    rerender(tree(false));
    await waitFor(() => expect(queryClient.getQueryData(['item', 'item-1'])).toBeTruthy());
  });

  it('retries a null detail miss instead of caching it forever', async () => {
    class FlakyDetailSource extends MockDataSource {
      calls = 0;
      async getItem(id: string) {
        this.calls += 1;
        return this.calls === 1 ? null : super.getItem(id);
      }
    }
    const source = new FlakyDetailSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    source.stateStore.set('item-1', 'pinned', true);
    // First warm gets null → not cached (would otherwise be pinned fresh forever).
    await waitFor(() => expect(source.calls).toBe(1));
    expect(queryClient.getQueryData(['item', 'item-1'])).toBeFalsy();

    // A later sync pass (favoriting it) retries and now caches the real detail.
    source.stateStore.set('item-1', 'favorite', true);
    await waitFor(() => expect(queryClient.getQueryData(['item', 'item-1'])).toBeTruthy());
  });

  it('re-locks already-pinned (hydrated) items on mount', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    // Pin BEFORE the hook mounts — simulates a pin restored from persistence.
    source.stateStore.set('item-2', 'pinned', true);
    const qc = setup(source);

    await waitFor(() => expect(qc.getQueryData(['item', 'item-2'])).toBeTruthy());
  });

  it('does not fetch the full body for a favorite-only item whose feed body is complete', async () => {
    class LongBodySource extends MockDataSource {
      async getItem(id: string) {
        const fi = await super.getItem(id);
        if (fi) {
          fi.item = { ...fi.item, contentHtml: `<p>${'plenty of words '.repeat(60)}</p>` };
        }
        return fi;
      }
    }
    const source = new LongBodySource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'favorite', true);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    // Favorite-only body is long enough → not truncated → no full-text fetch.
    expect(qc.getQueryData(['fulltext', 'item-1'])).toBeUndefined();
  });
});
