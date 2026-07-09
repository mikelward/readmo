import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  configureFeedFreshness,
  FEED_STALE_MS,
  rematerializeFeedsOnBoot,
} from './feedFreshness';

describe('configureFeedFreshness', () => {
  it('is a 6h cadence', () => {
    expect(FEED_STALE_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('scopes the frozen-set staleTime to feed queries only', () => {
    const qc = new QueryClient();
    configureFeedFreshness(qc);

    // Feed-items and the shared ['feed', …] prefix inherit the 6h cadence, so a
    // remount/focus within the window doesn't re-materialize the set.
    expect(qc.getQueryDefaults(['feed', 'home-all']).staleTime).toBe(
      FEED_STALE_MS,
    );
    expect(
      qc.getQueryDefaults(['feed', 'unread-counts', 'feed-a']).staleTime,
    ).toBe(FEED_STALE_MS);

    // gcTime is raised to match, so the frozen page survives an unmount (reading
    // an article) for the whole window rather than being GC'd at 60 min.
    expect(qc.getQueryDefaults(['feed', 'home-all']).gcTime).toBe(FEED_STALE_MS);

    // Non-feed queries are untouched — they keep the client's global default
    // (undefined here → falls back to the QueryClient default staleTime/gcTime).
    expect(qc.getQueryDefaults(['capabilities']).staleTime).toBeUndefined();
    expect(qc.getQueryDefaults(['feed-meta', 'feed-a']).staleTime).toBeUndefined();
  });
});

describe('rematerializeFeedsOnBoot', () => {
  it('marks restored feed queries stale and refetches the mounted one', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    configureFeedFreshness(qc);
    // A restored-from-persistence snapshot: fresh under the 6h TTL, so without
    // the boot invalidation neither view would fetch on open.
    qc.setQueryData(['feed', 'home-all'], { pages: [], pageParams: [] });
    qc.setQueryData(['feed', 'folder:news'], { pages: [], pageParams: [] });
    qc.setQueryData(['capabilities'], { family: false });

    // The home view is mounted (has an active observer).
    const fetchHome = vi.fn(() =>
      Promise.resolve({ pages: [['fresh']], pageParams: [null] }),
    );
    const observer = new QueryObserver(qc, {
      queryKey: ['feed', 'home-all'],
      queryFn: fetchHome,
      staleTime: FEED_STALE_MS,
    });
    const unsubscribe = observer.subscribe(() => {});

    rematerializeFeedsOnBoot(qc);

    // Both feed views are invalidated; the mounted one refetches now, the
    // unmounted one on its next mount. Non-feed queries are untouched.
    await vi.waitFor(() => expect(fetchHome).toHaveBeenCalled());
    expect(
      qc.getQueryCache().find({ queryKey: ['feed', 'folder:news'] })?.state
        .isInvalidated,
    ).toBe(true);
    expect(
      qc.getQueryCache().find({ queryKey: ['capabilities'] })?.state
        .isInvalidated,
    ).toBe(false);
    unsubscribe();
  });
});
