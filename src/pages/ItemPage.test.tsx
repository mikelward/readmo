import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IsRestoringProvider, QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetNetworkStatusForTests, reportFetchFailure } from '../lib/networkStatus';
import type { FeedItem } from '../lib/types';
import type { FullTextResult } from '../lib/fullText';
import { ItemPage } from './ItemPage';

function renderReader(
  source: MockDataSource,
  id = 'item-1',
  queryClient?: QueryClient,
) {
  return renderWithProviders(
    <Routes>
      <Route path="/item/:id" element={<ItemPage />} />
    </Routes>,
    { source, queryClient, route: `/item/${id}` },
  );
}

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

afterEach(() => {
  setOnline(true);
  _resetNetworkStatusForTests();
});

describe('ItemPage (reader)', () => {
  it('renders the article and marks it opened on view', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    await screen.findByTestId('open-original');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(source.stateStore.get('item-1').opened).toBe(true);
    });
  });

  it('shows the pin-to-load-faster tip while the article is loading', async () => {
    // Hold getItem open so the reader stays in the loading state.
    class HangingSource extends MockDataSource {
      getItem(): Promise<FeedItem | null> {
        return new Promise(() => {});
      }
    }
    renderReader(new HangingSource(`test-${Math.random()}`));
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(
      screen.getByText(/pin an article to make it load faster/),
    ).toBeInTheDocument();
  });

  it('pins from the reader action bar', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    const pin = await screen.findByTestId('reader-pin');
    await user.click(pin);
    expect(source.stateStore.get('item-1').pinned).toBe(true);
  });

  it('renders the toolbar at the bottom too and pins from it', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    const pin = await screen.findByTestId('reader-pin-bottom');
    expect(screen.getByTestId('open-original-bottom')).toBeInTheDocument();
    await user.click(pin);
    expect(source.stateStore.get('item-1').pinned).toBe(true);
  });

  it('renders the toolbar at the bottom with a back-to-top button and pins from it', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    const pin = await screen.findByTestId('reader-pin-bottom');
    expect(screen.getByTestId('open-original-bottom')).toBeInTheDocument();
    expect(screen.getByTestId('reader-back-to-top')).toBeInTheDocument();
    await user.click(pin);
    expect(source.stateStore.get('item-1').pinned).toBe(true);
  });

  it('Done marks the item done and clears pinned (exclusivity)', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);
    renderReader(source);
    const done = await screen.findByTestId('reader-done');
    await user.click(done);
    const state = source.stateStore.get('item-1');
    expect(state.done).toBe(true);
    expect(state.pinned).toBe(false);
  });

  it('opens the shared overflow menu from the More button and dismisses it on an outside tap', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    const more = await screen.findByTestId('reader-more');
    await user.click(more);
    // The reader now uses the shared ItemRowMenu (anchored popover), not the
    // old bespoke mouse-leave dropdown — so it carries Open feed and the
    // narrow-viewport Favorite/Share, and dismisses on outside tap / Escape.
    const menu = await screen.findByTestId('item-row-menu');
    expect(menu).toHaveAttribute('data-variant', 'popover');
    expect(screen.getByTestId('item-row-menu-open-feed')).toHaveTextContent(
      'Open feed',
    );
    // A tap outside the menu dismisses it (the bespoke menu only closed on
    // mouse-leave, which never fires on touch).
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('item-row-menu')).toBeNull();
    });
  });
});

describe('ItemPage reading mode', () => {
  it('shows the RSS body first and reveals the full article via "Keep reading"', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    // The seed item-1 body is a short stub. The reader shows that feed body
    // immediately and fetches the full article in the background — WITHOUT
    // swapping it in automatically (no reflow mid-read).
    expect(await screen.findByText(/visible creases/)).toBeInTheDocument();
    const keepReading = await screen.findByTestId('reader-keep-reading');
    expect(keepReading).toHaveTextContent('Keep reading');
    expect(screen.queryByText(/full article text/)).not.toBeInTheDocument();

    await user.click(keepReading);
    expect(await screen.findByText(/full article text/)).toBeInTheDocument();
    // The mode bar no longer carries a swap-back toggle; "Show feed version"
    // moved into the overflow menu so the happy path (stay in reading mode)
    // isn't crowded by a control most readers never use.
    expect(screen.queryByTestId('reader-view-toggle')).toBeNull();
    await user.click(screen.getByTestId('reader-more'));
    expect(
      await screen.findByTestId('item-row-menu-show-feed-version'),
    ).toHaveTextContent('Show feed version');
  });

  it('toggles between the reading view (mode bar) and the feed version (menu)', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    await user.click(await screen.findByTestId('reader-keep-reading'));
    await screen.findByText(/full article text/);

    // Swap back via the overflow menu.
    await user.click(screen.getByTestId('reader-more'));
    await user.click(
      await screen.findByTestId('item-row-menu-show-feed-version'),
    );
    expect(screen.queryByText(/full article text/)).not.toBeInTheDocument();
    // The original feed body is still present.
    expect(screen.getByText(/visible creases/)).toBeInTheDocument();

    // Back to the reading view via Keep reading on the mode bar.
    await user.click(screen.getByTestId('reader-keep-reading'));
    expect(await screen.findByText(/full article text/)).toBeInTheDocument();
  });

  it('opens straight into the reading view when the full body is already cached', async () => {
    const user = userEvent.setup();
    // A previously-read / pinned item already carries the extracted body.
    class CachedFullSource extends MockDataSource {
      async getItem(id: string): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        if (fi) {
          fi.item = { ...fi.item, fullContentHtml: '<p>cached reading body</p>' };
        }
        return fi;
      }
    }
    const source = new CachedFullSource(`test-${Math.random()}`);
    renderReader(source);
    // No Keep-reading step — the cached full body shows immediately.
    expect(await screen.findByText(/cached reading body/)).toBeInTheDocument();
    expect(screen.queryByTestId('reader-keep-reading')).not.toBeInTheDocument();
    // The swap-back-to-feed option lives in the overflow menu, not the mode bar.
    expect(screen.queryByTestId('reader-view-toggle')).toBeNull();
    await user.click(screen.getByTestId('reader-more'));
    expect(
      await screen.findByTestId('item-row-menu-show-feed-version'),
    ).toHaveTextContent('Show feed version');
  });

  it('paints the cached feed body immediately while the online detail read is still in flight', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // The item is already in a persisted list page (the user tapped it from a
    // feed they'd scrolled), so its feed body is on the device.
    const seed = new MockDataSource(`test-${Math.random()}`);
    queryClient.setQueryData(['feed', 'home'], {
      pages: [await seed.getHomeItems()],
      pageParams: [null],
    });

    // Online, but the per-item detail read never resolves — the reader must NOT
    // sit on a blank "Loading…"; it shows the cached feed body straight away.
    class HangingSource extends MockDataSource {
      getItem(): Promise<FeedItem | null> {
        return new Promise(() => {});
      }
    }
    renderReader(new HangingSource(`test-${Math.random()}`), 'item-1', queryClient);

    expect(await screen.findByText(/visible creases/)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('opens a pinned item straight into the cached reading view, no "Loading…" gap', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // The feed body is on the device from a list page...
    const seed = new MockDataSource(`test-${Math.random()}`);
    queryClient.setQueryData(['feed', 'home'], {
      pages: [await seed.getHomeItems()],
      pageParams: [null],
    });
    // ...and pinning prefetched the extracted full body into the fulltext query.
    queryClient.setQueryData(['fulltext', 'item-1'], {
      status: 'ok',
      contentHtml: '<p>pinned reading body</p>',
    });

    // Detail read hangs, but both bodies are cached: the reader opens directly
    // into the readability view without ever showing "Loading…".
    class HangingSource extends MockDataSource {
      getItem(): Promise<FeedItem | null> {
        return new Promise(() => {});
      }
    }
    renderReader(new HangingSource(`test-${Math.random()}`), 'item-1', queryClient);

    expect(await screen.findByText(/pinned reading body/)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reader-keep-reading')).not.toBeInTheDocument();
  });

  it('shows the cached RSS body when the detail read fails offline (unpinned)', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // Seed a list page already on the device — what the persisted feed cache
    // holds after the user has scrolled the feed. The Home view is an
    // infinite query, so the cached shape is { pages: Page[], pageParams }.
    // List payloads carry the RSS body (content_html); only full_content_html
    // is stripped.
    const seed = new MockDataSource(`test-${Math.random()}`);
    queryClient.setQueryData(['feed', 'home'], {
      pages: [await seed.getHomeItems()],
      pageParams: [null],
    });

    // Offline: the per-item detail read can't reach the network.
    class OfflineSource extends MockDataSource {
      async getItem(): Promise<FeedItem | null> {
        throw new Error('offline');
      }
    }
    setOnline(false);
    renderReader(new OfflineSource(`test-${Math.random()}`), 'item-1', queryClient);

    // The article's own feed body renders from the list cache — not the
    // "pin it while online to keep a copy" empty state.
    expect(await screen.findByText(/visible creases/)).toBeInTheDocument();
    expect(
      screen.queryByText(/isn.t saved offline/i),
    ).not.toBeInTheDocument();
    // No full-article fetch is attempted while offline.
    expect(screen.queryByTestId('fulltext-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reader-keep-reading')).not.toBeInTheDocument();
  });

  it('blames the server, not the user, when the backend is unreachable but the device is online', async () => {
    // Device has a connection (navigator.onLine stays true) but a hard fetch
    // failure flipped the network tracker, and there's no cached copy to fall
    // back to. The miss state must say the server is the problem — not "pin it
    // while online", which would wrongly imply the user is offline.
    reportFetchFailure(new TypeError('Failed to fetch'));
    class DownSource extends MockDataSource {
      async getItem(): Promise<FeedItem | null> {
        throw new Error('backend down');
      }
    }
    renderReader(new DownSource(`test-${Math.random()}`));

    expect(
      await screen.findByText(/server isn.t responding right now/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/isn.t saved offline/i)).not.toBeInTheDocument();
  });

  it('names the action and shows the error detail when online but the read errors', async () => {
    // Online (navigator.onLine true, no network-tracker failure), but the data
    // layer throws — the server responded with an error. The miss state must
    // name the action and expose the underlying message, NOT claim the server
    // "isn't responding" (it did) or that the user is offline.
    class ErroringSource extends MockDataSource {
      async getItem(): Promise<FeedItem | null> {
        throw new Error('column items.sort_at does not exist');
      }
    }
    renderReader(new ErroringSource(`test-${Math.random()}`));

    expect(
      await screen.findByText(/unexpected response fetching this article/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/isn.t responding/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/isn.t saved offline/i)).not.toBeInTheDocument();
    // The underlying cause is surfaced (behind the Details disclosure).
    expect(
      screen.getByText('column items.sort_at does not exist'),
    ).toBeInTheDocument();
  });

  it('respects a successful "not visible" miss while online (no stale-cache override)', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // The item is still in a persisted list cache...
    const seed = new MockDataSource(`test-${Math.random()}`);
    queryClient.setQueryData(['feed', 'home'], {
      pages: [await seed.getHomeItems()],
      pageParams: [null],
    });
    // ...but the server now says it isn't visible (e.g. after unsubscribing):
    // getItem resolves to null while ONLINE. We must respect that, not render
    // the stale list-cache row.
    class GoneSource extends MockDataSource {
      async getItem(): Promise<FeedItem | null> {
        return null;
      }
    }
    renderReader(new GoneSource(`test-${Math.random()}`), 'item-1', queryClient);

    expect(await screen.findByText(/Couldn.t load this article/i)).toBeInTheDocument();
    expect(screen.queryByText(/visible creases/)).not.toBeInTheDocument();
  });

  it('respects a cached "not visible" miss even offline (no stale-cache override)', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const seed = new MockDataSource(`test-${Math.random()}`);
    queryClient.setQueryData(['feed', 'home'], {
      pages: [await seed.getHomeItems()],
      pageParams: [null],
    });
    // A prior online getItem resolved to null (RLS hid the item) and is cached
    // as an authoritative miss. Going offline must NOT resurrect it from a stale
    // list cache — data === null is a successful result, not a failed read.
    queryClient.setQueryData(['item', 'item-1'], null);
    class GoneSource extends MockDataSource {
      async getItem(): Promise<FeedItem | null> {
        return null;
      }
    }
    setOnline(false);
    renderReader(new GoneSource(`test-${Math.random()}`), 'item-1', queryClient);

    expect(await screen.findByText(/isn.t saved offline/i)).toBeInTheDocument();
    expect(screen.queryByText(/visible creases/)).not.toBeInTheDocument();
  });

  it('recovers the offline RSS body once the persisted cache finishes hydrating', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // The persisted feed page (built ahead of time) is NOT in the cache yet —
    // it lands only when restoration finishes, modeling a cold offline start
    // where the reader mounts before PersistQueryClientProvider has hydrated.
    const seed = new MockDataSource(`test-${Math.random()}`);
    const homePage = await seed.getHomeItems();
    class OfflineSource extends MockDataSource {
      async getItem(): Promise<FeedItem | null> {
        throw new Error('offline');
      }
    }
    setOnline(false);

    // Drive React Query's restoration flag, flipping it false from the test to
    // model PersistQueryClientProvider finishing hydration.
    let finishRestoring: () => void = () => {};
    function Restoring({ children }: { children: ReactNode }) {
      const [restoring, setRestoring] = useState(true);
      finishRestoring = () => setRestoring(false);
      return <IsRestoringProvider value={restoring}>{children}</IsRestoringProvider>;
    }

    renderWithProviders(
      <Restoring>
        <Routes>
          <Route path="/item/:id" element={<ItemPage />} />
        </Routes>
      </Restoring>,
      { source: new OfflineSource(`test-${Math.random()}`), queryClient, route: '/item/item-1' },
    );

    // While restoring (cache still empty): wait, don't paint the miss state.
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(screen.queryByText(/visible creases/)).not.toBeInTheDocument();
    expect(screen.queryByText(/isn.t saved offline/i)).not.toBeInTheDocument();

    // Restoration completes: the list cache is now populated AND isRestoring
    // flips — the fallback must re-scan and find the body (the regression was it
    // staying null because the memo didn't recompute).
    act(() => {
      queryClient.setQueryData(['feed', 'home'], {
        pages: [homePage],
        pageParams: [null],
      });
      finishRestoring();
    });
    expect(await screen.findByText(/visible creases/)).toBeInTheDocument();
    expect(screen.queryByText(/isn.t saved offline/i)).not.toBeInTheDocument();
  });

  it('opens to the reading view when full text is already cached in the fulltext query', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // A prefetch (pin/favorite) or earlier open cached the full body in the
    // fulltext query, even though the item snapshot's full_content_html is null.
    queryClient.setQueryData(['fulltext', 'item-1'], {
      status: 'ok',
      contentHtml: '<p>prefetched reading body</p>',
    });
    renderReader(new MockDataSource(`test-${Math.random()}`), 'item-1', queryClient);

    // Opens straight into the reading view — no Keep-reading step.
    expect(await screen.findByText(/prefetched reading body/)).toBeInTheDocument();
    expect(screen.queryByTestId('reader-keep-reading')).not.toBeInTheDocument();
    // Show-feed-version sits in the overflow menu.
    expect(screen.queryByTestId('reader-view-toggle')).toBeNull();
    await user.click(screen.getByTestId('reader-more'));
    expect(
      await screen.findByTestId('item-row-menu-show-feed-version'),
    ).toHaveTextContent('Show feed version');
  });

  it('falls back to the feed body and explains when the article needs sign-in', async () => {
    class AuthSource extends MockDataSource {
      async fetchFullText(): Promise<FullTextResult> {
        return { status: 'auth', contentHtml: null };
      }
    }
    const source = new AuthSource(`test-${Math.random()}`);
    renderReader(source);
    const note = await screen.findByTestId('fulltext-error');
    expect(note).toHaveTextContent(/sign in/i);
    // The feed body is still rendered so the reader isn't left empty.
    expect(screen.getByText(/visible creases/)).toBeInTheDocument();
  });

  it('stays silent and offers Open original when a complete feed entry has no readable version', async () => {
    const user = userEvent.setup();
    // A complete feed body (not truncated) that extracts to nothing — the
    // common link-aggregator case (e.g. a Reddit post where the entry already
    // is the whole story). Because it isn't truncated it isn't auto-fetched, so
    // the reader requests reading mode manually.
    class EmptyLongSource extends MockDataSource {
      async getItem(id: string): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        if (fi) {
          fi.item = { ...fi.item, contentHtml: `<p>${'plenty of words '.repeat(60)}</p>` };
        }
        return fi;
      }
      async fetchFullText(): Promise<FullTextResult> {
        return { status: 'empty', contentHtml: null };
      }
    }
    const source = new EmptyLongSource(`test-${Math.random()}`);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderReader(source);

    await user.click(await screen.findByTestId('fulltext-get'));
    // Extraction found nothing, but the feed body is complete — no alarming
    // note is shown…
    const openOriginal = await screen.findByTestId('fulltext-open-original');
    expect(screen.queryByTestId('fulltext-error')).not.toBeInTheDocument();

    // …and the Open-original escape hatch stays put.
    await user.click(openOriginal);
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('http'),
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('stays silent for a short auto-fetched entry that has no readable version', async () => {
    // The default item-1 body is short, so it reads as truncated and reading
    // mode auto-fetches. A short *complete* entry (e.g. a Reddit link post) is
    // indistinguishable by length from a teaser, so an `empty` result here must
    // stay silent rather than show the alarming note — only the Open-original
    // escape hatch and the feed body remain.
    class EmptySource extends MockDataSource {
      async fetchFullText(): Promise<FullTextResult> {
        return { status: 'empty', contentHtml: null };
      }
    }
    const source = new EmptySource(`test-${Math.random()}`);
    renderReader(source);

    // Wait for the auto-fetch to settle, then assert no note appeared.
    await screen.findByText(/visible creases/);
    await waitFor(() =>
      expect(screen.queryByTestId('fulltext-loading')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('fulltext-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('fulltext-open-original')).toBeInTheDocument();
  });

  it('offers a retry for a transient failure and recovers on retry', async () => {
    const user = userEvent.setup();
    class FlakySource extends MockDataSource {
      calls = 0;
      async fetchFullText(): Promise<FullTextResult> {
        this.calls += 1;
        return this.calls === 1
          ? { status: 'unreachable', contentHtml: null }
          : { status: 'ok', contentHtml: '<p>recovered full body</p>' };
      }
    }
    const source = new FlakySource(`test-${Math.random()}`);
    renderReader(source);
    // First attempt failed transiently: feed body stays, a retry is offered.
    const retry = await screen.findByTestId('fulltext-retry');
    expect(screen.getByText(/visible creases/)).toBeInTheDocument();

    await user.click(retry);
    // Recovered: reveal the full body via Keep reading (no auto-swap).
    await user.click(await screen.findByTestId('reader-keep-reading'));
    expect(await screen.findByText(/recovered full body/)).toBeInTheDocument();
  });

  it('offers an "Open original" escape hatch while the full article loads', async () => {
    const user = userEvent.setup();
    // Hold the full-text fetch open so the reader stays in the loading state
    // (no racy timing — we settle the gate explicitly at the end).
    let release: (result: FullTextResult) => void = () => {};
    class SlowSource extends MockDataSource {
      fetchFullText(): Promise<FullTextResult> {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    }
    const source = new SlowSource(`test-${Math.random()}`);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderReader(source);

    // The modebar shows the loading note plus an Open-original button so the
    // reader can jump to the source without waiting for extraction.
    expect(await screen.findByTestId('fulltext-loading')).toBeInTheDocument();
    await user.click(screen.getByTestId('fulltext-open-original'));
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('http'),
      '_blank',
      'noopener,noreferrer',
    );

    // Settle the in-flight fetch so no pending promise leaks past the test.
    act(() => release({ status: 'ok', contentHtml: '<p>full article text</p>' }));
    await screen.findByTestId('reader-keep-reading');
    openSpy.mockRestore();
  });

  it('offers a manual "Get full article" control for an untruncated feed', async () => {
    const user = userEvent.setup();
    // A feed item whose own body is already long enough not to look truncated.
    class LongBodySource extends MockDataSource {
      async getItem(id: string): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        if (fi) {
          fi.item = { ...fi.item, contentHtml: `<p>${'plenty of words '.repeat(60)}</p>` };
        }
        return fi;
      }
    }
    const source = new LongBodySource(`test-${Math.random()}`);
    renderReader(source);
    const get = await screen.findByTestId('fulltext-get');
    // No auto-fetch happened — nothing for the reader to "keep reading" yet.
    expect(screen.queryByTestId('reader-keep-reading')).toBeNull();

    await user.click(get);
    expect(await screen.findByText(/full article text/)).toBeInTheDocument();
  });
});
