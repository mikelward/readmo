import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IsRestoringProvider, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderWithProviders as baseRender } from '../test/renderWithProviders';
import { ToastProvider } from '../components/Toast';
import { FeedBarProvider } from '../components/FeedBarContext';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetNetworkStatusForTests, trackedFetch } from '../lib/networkStatus';
import { CAPABILITIES_QUERY_KEY } from '../hooks/useCapabilities';
import {
  AUTO_SUMMARIZE_PINNED_KEY,
  SAVE_SERVICE_KEY,
  AUTO_SAVE_ON_FAVORITE_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';
import { readLaterTarget } from '../lib/readLater';
import type { Feed, FeedItem, Item, ItemId } from '../lib/types';
import type { Capabilities } from '../lib/data/DataSource';
import type { FullTextResult } from '../lib/fullText';
import type { SummaryResult } from '../lib/summary';
import { ItemPage } from './ItemPage';
import { recallHackerNewsItemId } from '../lib/newshackerItemIds';

// Full text + AI summaries gate on useFullTextAllowed, which is now closed until
// capabilities RESOLVE to allowed (a signed-out caller is never allowlisted).
// Seed a disarmed (open-to-all) capability set so the reader exercises the
// allowed path, as these tests did when signed-out defaulted open.
const ALLOWED_CAPS: Capabilities = {
  family: false,
  admin: false,
  allowlistArmed: false,
  // The deployed backend has migration 0068, so the reader's Share hands out the
  // hosted /item/:id link (a test seeds its own caps to model an older backend).
  sharedItems: true,
};
function seedAllowed(qc: QueryClient): QueryClient {
  // Non-clobbering: a test that seeds its OWN capabilities (e.g. an armed,
  // off-allowlist caller) keeps them; only an unseeded client gets the allowed
  // default.
  if (qc.getQueryData(CAPABILITIES_QUERY_KEY) === undefined) {
    qc.setQueryData(CAPABILITIES_QUERY_KEY, ALLOWED_CAPS);
  }
  return qc;
}
// Shadow the shared helper so every render seeds the allowed capability set on
// whatever query client it ends up using.
function renderWithProviders(
  ui: ReactElement,
  opts: { route?: string; source?: MockDataSource; queryClient?: QueryClient } = {},
) {
  const queryClient =
    opts.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  seedAllowed(queryClient);
  return baseRender(ui, { ...opts, queryClient });
}

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

// Surfaces the current path so the u / b navigation shortcuts can be asserted.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-pathname">{loc.pathname}</div>;
}

// Renders the reader inside a multi-entry MemoryRouter so `b` (navigate(-1))
// has somewhere to pop back to, and `u` has a feed route to land on.
function renderReaderWithHistory(
  source: MockDataSource,
  { entries, queryClient: passedClient }: { entries: string[]; queryClient?: QueryClient },
) {
  const queryClient = seedAllowed(
    passedClient ??
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <DataSourceProvider source={source}>
        <ToastProvider>
          <FeedBarProvider>
            <MemoryRouter
              initialEntries={entries}
              initialIndex={entries.length - 1}
            >
              <LocationProbe />
              <Routes>
                <Route path="/item/:id" element={<ItemPage />} />
                <Route path="/feed/:id" element={<div data-testid="route-feed" />} />
                <Route path="*" element={<div data-testid="route-other" />} />
              </Routes>
            </MemoryRouter>
          </FeedBarProvider>
        </ToastProvider>
      </DataSourceProvider>
    </QueryClientProvider>,
  );
}

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

// jsdom makes window.location.assign a non-configurable, non-writable data
// property, so it can't be spied or wrapped in a Proxy (the invariant forbids
// returning a different value). Replace window.location with a plain stub that
// copies the readable fields and swaps in mock navigation methods, so a test
// can assert same-tab navigation, then restore the real location.
function mockLocationAssign() {
  const assign = vi.fn();
  const real = window.location;
  const stub = {
    assign,
    replace: vi.fn(),
    reload: vi.fn(),
    href: real.href,
    origin: real.origin,
    protocol: real.protocol,
    host: real.host,
    hostname: real.hostname,
    port: real.port,
    pathname: real.pathname,
    search: real.search,
    hash: real.hash,
    toString: () => real.href,
  };
  Object.defineProperty(window, 'location', { configurable: true, value: stub });
  return {
    assign,
    restore: () =>
      Object.defineProperty(window, 'location', { configurable: true, value: real }),
  };
}

afterEach(() => {
  setOnline(true);
  _resetNetworkStatusForTests();
  window.localStorage.removeItem(AUTO_SUMMARIZE_PINNED_KEY);
  window.localStorage.removeItem(SAVE_SERVICE_KEY);
  window.localStorage.removeItem(AUTO_SAVE_ON_FAVORITE_KEY);
  resetReadingPrefsCacheForTest();
});

describe('ItemPage (reader)', () => {
  it('remembers the HN item id when reading an HN article (for the mirror)', async () => {
    class HnReaderSource extends MockDataSource {
      async getItem(itemId: ItemId): Promise<FeedItem | null> {
        return {
          item: {
            id: itemId,
            feedId: 'hn',
            guid: 'g',
            url: 'https://example.com/a',
            commentsUrl: 'https://news.ycombinator.com/item?id=8675309',
            title: 'A story',
            spoilerFreeTitle: null,
            author: null,
            publishedAt: 0,
            contentHtml: '<p>body</p>',
            summary: null,
            fullContentHtml: null,
            aiSummary: null,
            enclosures: [],
          } as Item,
          feed: {
            id: 'hn',
            url: 'https://news.ycombinator.com/rss',
            siteUrl: 'https://news.ycombinator.com/',
          } as Feed,
        };
      }
    }
    const source = new HnReaderSource(`test-${Math.random()}`);
    renderReader(source, 'hn-read-1');
    await waitFor(() =>
      expect(recallHackerNewsItemId('hn-read-1')).toBe(8675309),
    );
  });

  it('does not auto-generate the summary for the next item after navigating from a pinned one', async () => {
    // Regression: `pinnedAtOpen` must be keyed to the rendered item, not left as
    // a stale snapshot from the previous article. Navigating a pinned → unpinned
    // item in the SAME ItemPage instance must not leak a `getSummary` call for
    // the unpinned one before the snapshot updates.
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true); // pinned before opening
    const calledFor: string[] = [];
    const orig = source.getSummary.bind(source);
    source.getSummary = (id) => {
      calledFor.push(id);
      return orig(id);
    };

    function Nav() {
      const navigate = useNavigate();
      return (
        <button data-testid="go-item-2" onClick={() => navigate('/item/item-2')}>
          go
        </button>
      );
    }

    const queryClient = seedAllowed(
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <ToastProvider>
            <FeedBarProvider>
              <MemoryRouter initialEntries={['/item/item-1']}>
                <Nav />
                <Routes>
                  <Route path="/item/:id" element={<ItemPage />} />
                </Routes>
              </MemoryRouter>
            </FeedBarProvider>
          </ToastProvider>
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    // item-1 was pinned before opening → the summary auto-generates.
    await screen.findByTestId('article-summary-body');
    expect(calledFor).toContain('item-1');

    // Navigate to the unpinned item-2 without unmounting: it must offer the
    // Generate button, and never fire getSummary for item-2 on its own.
    await userEvent.click(screen.getByTestId('go-item-2'));
    expect(await screen.findByTestId('article-summary-generate')).toBeInTheDocument();
    expect(calledFor).not.toContain('item-2');
  });

  it('offers the Generate button (no auto-generation) for a pinned open when auto-summarize is off', async () => {
    // The "Auto generate summaries for pinned articles" toggle gates the
    // reader's pinned auto-generation, not just the pre-warm: with it off, a
    // pinned open behaves like an unpinned one — a Generate button, zero
    // getSummary calls, no "Summarizing…" flash.
    window.localStorage.setItem(AUTO_SUMMARIZE_PINNED_KEY, '0');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true); // pinned before opening
    const calledFor: string[] = [];
    const orig = source.getSummary.bind(source);
    source.getSummary = (id) => {
      calledFor.push(id);
      return orig(id);
    };

    renderReader(source, 'item-1');

    expect(await screen.findByTestId('article-summary-generate')).toBeInTheDocument();
    expect(screen.queryByTestId('article-summary-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('article-summary-body')).not.toBeInTheDocument();
    expect(calledFor).toHaveLength(0);

    // The button still works — auto-summarize off gates the automatic spend,
    // not the user's explicit ask.
    await userEvent.click(screen.getByTestId('article-summary-generate'));
    await screen.findByTestId('article-summary-body');
    expect(calledFor).toEqual(['item-1']);
  });

  it('shows the list-row summary instantly when its content still matches the fresh item', async () => {
    const queryClient = seedAllowed(
      new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
    );
    const seed = new MockDataSource(`test-${Math.random()}`);
    const base = (await seed.getItem('item-1'))!;
    // The persisted list row carries a cached summary for content that still
    // matches what the fresh getItem returns (same body/title).
    queryClient.setQueryData(['feed', 'home'], {
      pages: [{ items: [{ ...base, item: { ...base.item, aiSummary: 'Cached row gist.' } }] }],
      pageParams: [null],
    });

    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true); // pinned → would auto-generate
    const spy = vi.spyOn(source, 'getSummary');
    renderReader(source, 'item-1', queryClient);

    // Rendered from the row, instantly, with no `summary` Edge call.
    expect(await screen.findByTestId('article-summary-body')).toHaveTextContent(
      'Cached row gist.',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops a stale list-row summary whose content no longer matches the fresh item, and regenerates', async () => {
    const queryClient = seedAllowed(
      new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
    );
    const seed = new MockDataSource(`test-${Math.random()}`);
    const base = (await seed.getItem('item-1'))!;
    // The persisted list row still holds a summary of the OLD body.
    queryClient.setQueryData(['feed', 'home'], {
      pages: [
        {
          items: [
            {
              ...base,
              item: {
                ...base.item,
                contentHtml: '<p>the old body</p>',
                aiSummary: 'Stale gist of the old body.',
              },
            },
          ],
        },
      ],
      pageParams: [null],
    });

    // A publisher edit: the fresh detail read returns NEW content (and, like all
    // getItem reads, no ai_summary — the server nulled items.ai_summary on edit).
    class EditedSource extends MockDataSource {
      async getItem(id: string): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        if (fi) fi.item = { ...fi.item, contentHtml: '<p>the fresh body</p>', aiSummary: null };
        return fi;
      }
      async getSummary(): Promise<SummaryResult> {
        return { status: 'ok', summary: 'Fresh gist of the new body.' };
      }
    }
    const source = new EditedSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true); // pinned → auto-generate
    const spy = vi.spyOn(source, 'getSummary');
    renderReader(source, 'item-1', queryClient);

    // The stale gist must NOT survive: once the fresh read lands, the content
    // mismatch drops it and useSummary regenerates.
    await waitFor(() =>
      expect(screen.getByTestId('article-summary-body')).toHaveTextContent(
        'Fresh gist of the new body.',
      ),
    );
    expect(screen.queryByText(/Stale gist/)).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(
      'item-1',
      // The queryFn threads React Query's per-fetch abort signal through.
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('renders the article and marks it opened on view', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    await screen.findByTestId('open-original');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(source.stateStore.get('item-1').opened).toBe(true);
    });
  });

  it('shows the feed name next to the leading button in both toolbars, linking to the feed', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source, 'item-1');
    const top = await screen.findByTestId('reader-feedname');
    const bottom = screen.getByTestId('reader-feedname-bottom');
    expect(top).toHaveTextContent('The Verge');
    expect(bottom).toHaveTextContent('The Verge');
    expect(top).toHaveAttribute('href', '/feed/feed-verge');
    expect(bottom).toHaveAttribute('href', '/feed/feed-verge');
  });

  it("shows the feed's favicon next to the feed name in both toolbars", async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source, 'item-1');
    const top = await screen.findByTestId('reader-feedname-favicon');
    const bottom = screen.getByTestId('reader-feedname-favicon-bottom');
    // The Verge's favicon, decorative, and sitting inside the feed-name link.
    expect(top).toHaveAttribute('src', 'https://www.theverge.com/favicon.ico');
    expect(top).toHaveAttribute('alt', '');
    expect(top.closest('[data-testid="reader-feedname"]')).not.toBeNull();
    expect(bottom).toHaveAttribute('src', 'https://www.theverge.com/favicon.ico');
    expect(bottom.closest('[data-testid="reader-feedname-bottom"]')).not.toBeNull();
  });

  it('shows an initials badge when the feed advertises no favicon', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const detail = (await source.getItem('item-1'))!;
    vi.spyOn(source, 'getItem').mockResolvedValue({
      ...detail,
      feed: { ...detail.feed, faviconUrl: null },
    });
    renderReader(source, 'item-1');
    await screen.findByTestId('reader-feedname');
    // No <img>, but the feed's initials badge (The Verge → "V") stands in.
    const badge = screen.getByTestId('reader-feedname-favicon');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveClass('favicon--initials');
    expect(badge.textContent).toBe('V');
  });

  it('shows the article domain in the meta line below the title when it links off-site', async () => {
    // item-8 is the Reddit "Show" post, which links out to github.com.
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source, 'item-8');
    const domain = await screen.findByTestId('reader-domain');
    expect(domain).toHaveTextContent('github.com');
    // It lives in the byline meta line under the title, not a header source link.
    expect(domain.closest('.reader__byline')).not.toBeNull();
  });

  it('omits the domain when the article lives on the feed\'s own site', async () => {
    // item-1 is a Verge article on theverge.com, the feed's own site.
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source, 'item-1');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('reader-domain')).not.toBeInTheDocument();
  });

  it('does not repeat the feed name in the header (it lives on the reader bars now)', async () => {
    // item-1's feed is "The Verge"; that name should appear only on the bars
    // (reader-feedname), not in the header, which now shows just title + meta.
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source, 'item-1');
    const heading = await screen.findByRole('heading', { level: 1 });
    const header = heading.closest('.reader__header');
    expect(header).not.toBeNull();
    expect(header).not.toHaveTextContent('The Verge');
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

  it('orders the action cluster Pin then Done, with Done second from the right (left of More)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    const pin = await screen.findByTestId('reader-pin');
    const toolbar = pin.closest('.reader__actions');
    expect(toolbar).not.toBeNull();
    const actionOrder = Array.from(
      toolbar!.querySelectorAll('[data-testid]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(actionOrder).toEqual([
      'open-original',
      'reader-pin',
      'reader-done',
      'reader-more',
    ]);
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

  it('Done with no back entry closes the tab, then falls back to the home list', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    // Single router entry → location.key === 'default', and no back entry
    // (window.history.length === 1 in jsdom). Done tries to close the tab
    // (dismissing a new tab / Custom Tab into the opener) and, since the browser
    // won't close it here, falls back to '/' rather than stranding the reader.
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    renderReaderWithHistory(source, { entries: ['/item/item-1'] });
    const done = await screen.findByTestId('reader-done');
    await user.click(done);
    expect(source.stateStore.get('item-1').done).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent('/');
    });
  });

  it('Done on an external deep link pops back to the referrer, not the home list', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    // Single router entry (location.key === 'default') but the browser has a
    // page behind us — the reader opened this article from an external app in
    // the same tab, so that page is history[-1]. window.history.length > 1 →
    // goBack pops with navigate(-1) to return there rather than redirecting to
    // '/'. MemoryRouter can't pop past its one entry, so the path stays on the
    // article — the point is that we do NOT fall back to the home list.
    const orig = Object.getOwnPropertyDescriptor(window.history, 'length');
    Object.defineProperty(window.history, 'length', {
      configurable: true,
      value: 2,
    });
    try {
      renderReaderWithHistory(source, { entries: ['/item/item-1'] });
      const done = await screen.findByTestId('reader-done');
      await user.click(done);
      expect(source.stateStore.get('item-1').done).toBe(true);
      await waitFor(() => {
        expect(screen.getByTestId('location-pathname')).toHaveTextContent(
          '/item/item-1',
        );
      });
    } finally {
      if (orig) Object.defineProperty(window.history, 'length', orig);
      else delete (window.history as unknown as { length?: number }).length;
    }
  });

  it('Open original marks the item done and pops back when the feed opts into mark-done-when-opening', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const source = new MockDataSource(`test-${Math.random()}`);
    await source.setMarkDoneOnOpen('feed-verge', true); // item-1's feed
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // Prewarm the subscriptions query so useMarkDoneOnOpenFeeds has the flag by
    // the time the button is clicked (deterministic, no timing race).
    await queryClient.prefetchQuery({
      queryKey: ['subscriptions'],
      queryFn: () => source.getSubscriptions(),
    });
    renderReaderWithHistory(source, { entries: ['/', '/item/item-1'], queryClient });
    const openOriginal = await screen.findByTestId('open-original');
    await user.click(openOriginal);
    // Opened the source in a new tab AND marked the item done (clearing pinned).
    expect(openSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(source.stateStore.get('item-1').done).toBe(true);
    });
    // …and dropped back to the previous page, the completion flow.
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent('/');
    });
    openSpy.mockRestore();
  });

  it('Open original does NOT mark done for a normal feed (setting off)', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReaderWithHistory(source, { entries: ['/', '/item/item-1'] });
    const openOriginal = await screen.findByTestId('open-original');
    await user.click(openOriginal);
    expect(openSpy).toHaveBeenCalled();
    // Opened, but not done — and still on the reader (no pop-back).
    await waitFor(() => {
      expect(source.stateStore.get('item-1').opened).toBe(true);
    });
    expect(source.stateStore.get('item-1').done).toBe(false);
    expect(screen.getByTestId('location-pathname')).toHaveTextContent('/item/item-1');
    openSpy.mockRestore();
  });

  it('merely opening the article view never marks done, even when the feed opts in', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    await source.setMarkDoneOnOpen('feed-verge', true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    await queryClient.prefetchQuery({
      queryKey: ['subscriptions'],
      queryFn: () => source.getSubscriptions(),
    });
    renderReaderWithHistory(source, { entries: ['/', '/item/item-1'], queryClient });
    await screen.findByTestId('open-original');
    // The reader open marks the item opened but must NOT mark it done — the
    // setting is scoped to the outbound open-original / newshacker actions.
    await waitFor(() => {
      expect(source.stateStore.get('item-1').opened).toBe(true);
    });
    expect(source.stateStore.get('item-1').done).toBe(false);
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

  it('shows the real headline in the reader (no de-spoiler marker) and shares it, even when a spoiler-free rewrite exists', async () => {
    // A spoiler-free rewrite exists, but the reader always shows the REAL title
    // — the rewrite is a list-only affordance; the body reveals the result here
    // anyway. (The list still hides it; see ItemRow.)
    class SpoilerSource extends MockDataSource {
      async getItem(id: ItemId): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        if (!fi) return null;
        return {
          ...fi,
          item: {
            ...fi.item,
            title: 'Man Utd beat Arsenal 3-1 to go top',
            spoilerFreeTitle: 'EPL MNU v ARS spoiler',
          },
        };
      }
    }
    const user = userEvent.setup();
    const shareFn = vi.fn().mockResolvedValue(undefined);
    const prev = Object.getOwnPropertyDescriptor(window.navigator, 'share');
    Object.defineProperty(window.navigator, 'share', {
      value: shareFn,
      configurable: true,
    });
    try {
      renderReader(new SpoilerSource(`test-${Math.random()}`));
      // The reader headline is the real title, with no de-spoiler marker.
      const title = await screen.findByRole('heading', { level: 1 });
      expect(title).toHaveTextContent('Man Utd beat Arsenal 3-1 to go top');
      expect(screen.queryByTestId('reader-spoiler-flag')).toBeNull();

      // Share sends the real title too (no spoiler-free rewrite to protect).
      await user.click(screen.getByTestId('reader-more'));
      await screen.findByTestId('item-row-menu');
      await user.click(screen.getByTestId('item-row-menu-share'));

      expect(shareFn).toHaveBeenCalledTimes(1);
      const payload = shareFn.mock.calls[0][0] as { title: string; text: string };
      expect(payload.title).toBe('Man Utd beat Arsenal 3-1 to go top');
    } finally {
      if (prev) Object.defineProperty(window.navigator, 'share', prev);
      else delete (window.navigator as { share?: unknown }).share;
    }
  });

  it('Share hands out the Readmo reader link; "Share original" shares the publisher URL', async () => {
    class FixedSource extends MockDataSource {
      async getItem(id: ItemId): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        if (!fi) return null;
        return {
          ...fi,
          item: { ...fi.item, id: 'item-1', url: 'https://publisher.example/story' },
        };
      }
    }
    const user = userEvent.setup();
    const shareFn = vi.fn().mockResolvedValue(undefined);
    const prev = Object.getOwnPropertyDescriptor(window.navigator, 'share');
    Object.defineProperty(window.navigator, 'share', {
      value: shareFn,
      configurable: true,
    });
    try {
      renderReader(new FixedSource(`test-${Math.random()}`), 'item-1');

      // Primary "Share" → our hosted /item/:id reader link (opens in Readmo).
      await user.click(await screen.findByTestId('reader-more'));
      await screen.findByTestId('item-row-menu');
      await user.click(screen.getByTestId('item-row-menu-share'));
      expect(shareFn).toHaveBeenCalledTimes(1);
      expect((shareFn.mock.calls[0][0] as { url: string }).url).toBe(
        `${window.location.origin}/item/item-1`,
      );

      // "Share original" → the publisher's canonical page.
      await user.click(screen.getByTestId('reader-more'));
      await screen.findByTestId('item-row-menu');
      await user.click(screen.getByTestId('item-row-menu-share-original'));
      expect(shareFn).toHaveBeenCalledTimes(2);
      expect((shareFn.mock.calls[1][0] as { url: string }).url).toBe(
        'https://publisher.example/story',
      );
    } finally {
      if (prev) Object.defineProperty(window.navigator, 'share', prev);
      else delete (window.navigator as { share?: unknown }).share;
    }
  });

  it('renders a shared-only (non-subscriber) open read-only: no Pin/Favorite/Done', async () => {
    // A public-feed article resolved via a shared link the caller doesn't
    // subscribe to (get_shared_item). item_state writes would be RLS-rejected, so
    // the triage actions are hidden; reading + Share still work.
    class SharedSource extends MockDataSource {
      async getItem(id: ItemId): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        return fi ? { ...fi, shared: true } : null;
      }
    }
    const user = userEvent.setup();
    renderReader(new SharedSource(`test-${Math.random()}`), 'item-1');
    // The article still renders.
    await screen.findByRole('heading', { level: 1 });
    // The item_state write actions are gone from the toolbar.
    expect(screen.queryByTestId('reader-pin')).toBeNull();
    expect(screen.queryByTestId('reader-done')).toBeNull();
    expect(screen.queryByTestId('reader-favorite')).toBeNull();
    // Feed navigation is neutralized (the feed page is subscription-scoped and
    // wouldn't load): the feed name is a plain label, not a link.
    expect(screen.getByTestId('reader-feedname').tagName).toBe('DIV');
    // …and from the overflow menu, while Share stays. "Open feed" is omitted.
    await user.click(await screen.findByTestId('reader-more'));
    await screen.findByTestId('item-row-menu');
    expect(screen.queryByTestId('item-row-menu-pin')).toBeNull();
    expect(screen.queryByTestId('item-row-menu-favorite')).toBeNull();
    expect(screen.queryByTestId('item-row-menu-open-feed')).toBeNull();
    expect(screen.getByTestId('item-row-menu-share')).toBeInTheDocument();
  });

  it('a shared-only reader records no item_state writes (mount Opened + Open original)', async () => {
    // The non-subscriber can't persist item_state, so neither the auto-open nor
    // the Open-original click should queue a doomed (RLS-rejected) Opened write.
    class SharedSource extends MockDataSource {
      async getItem(id: ItemId): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        return fi ? { ...fi, shared: true } : null;
      }
    }
    const source = new SharedSource(`test-${Math.random()}`);
    const setSpy = vi.spyOn(source.stateStore, 'set');
    const openSpy = vi.fn();
    const prevOpen = window.open;
    window.open = openSpy as typeof window.open;
    try {
      renderReader(source, 'item-1');
      await screen.findByRole('heading', { level: 1 });
      // Mount did not auto-write Opened for a shared-only reader.
      expect(setSpy).not.toHaveBeenCalledWith('item-1', 'opened', true);
      // Open original still opens the page, but records no Opened write.
      await userEvent.setup().click(screen.getByTestId('open-original'));
      expect(openSpy).toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalledWith('item-1', 'opened', true);
    } finally {
      window.open = prevOpen;
    }
  });

  it('falls back to the publisher URL for Share when the backend lacks shared items (old backend)', async () => {
    // sharedItems absent (a client ahead of migration 0068): Share must hand out
    // the publisher URL, since a /item/:id link couldn't be resolved yet, and the
    // redundant "Share original" entry is dropped.
    class FixedSource extends MockDataSource {
      async getItem(id: ItemId): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        if (!fi) return null;
        return { ...fi, item: { ...fi.item, id: 'item-1', url: 'https://publisher.example/story' } };
      }
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    qc.setQueryData(CAPABILITIES_QUERY_KEY, {
      family: false,
      admin: false,
      allowlistArmed: false,
    } satisfies Capabilities);

    const user = userEvent.setup();
    const shareFn = vi.fn().mockResolvedValue(undefined);
    const prev = Object.getOwnPropertyDescriptor(window.navigator, 'share');
    Object.defineProperty(window.navigator, 'share', { value: shareFn, configurable: true });
    try {
      renderReader(new FixedSource(`test-${Math.random()}`), 'item-1', qc);
      await user.click(await screen.findByTestId('reader-more'));
      await screen.findByTestId('item-row-menu');
      // No separate "Share original" — the primary Share already IS the publisher URL.
      expect(screen.queryByTestId('item-row-menu-share-original')).toBeNull();
      await user.click(screen.getByTestId('item-row-menu-share'));
      expect((shareFn.mock.calls[0][0] as { url: string }).url).toBe(
        'https://publisher.example/story',
      );
    } finally {
      if (prev) Object.defineProperty(window.navigator, 'share', prev);
      else delete (window.navigator as { share?: unknown }).share;
    }
  });

  it('shows no save option in the menu when no save service is chosen (default)', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    const more = await screen.findByTestId('reader-more');
    await user.click(more);
    await screen.findByTestId('item-row-menu');
    expect(screen.queryByTestId('item-row-menu-save-instapaper')).toBeNull();
    expect(screen.queryByTestId('item-row-menu-save-raindrop')).toBeNull();
    expect(screen.queryByTestId('item-row-menu-save-readwise')).toBeNull();
  });

  it('offers the chosen save service as a deep link to its save page', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(SAVE_SERVICE_KEY, 'raindrop');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    const fi = await source.getItem('item-1');
    const expected = readLaterTarget('raindrop', fi!.item.url, fi!.item.title)!;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      renderReader(source);
      const more = await screen.findByTestId('reader-more');
      await user.click(more);
      await screen.findByTestId('item-row-menu');

      // Only the chosen service is offered.
      expect(screen.queryByTestId('item-row-menu-save-instapaper')).toBeNull();
      expect(screen.getByTestId('item-row-menu-save-raindrop')).toHaveTextContent(
        'Save to Raindrop',
      );

      await user.click(screen.getByTestId('item-row-menu-save-raindrop'));
      expect(openSpy).toHaveBeenCalledWith(
        expected.href,
        '_blank',
        'noopener,noreferrer',
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it('auto-saves to the chosen service when favoriting, if auto-save is on', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(SAVE_SERVICE_KEY, 'raindrop');
    window.localStorage.setItem(AUTO_SAVE_ON_FAVORITE_KEY, '1');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    const fi = await source.getItem('item-1');
    const expected = readLaterTarget('raindrop', fi!.item.url, fi!.item.title)!;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      renderReader(source);
      await screen.findByTestId('reader-more');
      // Favorite via the `f` shortcut (a real gesture, like the button/menu).
      await user.keyboard('f');
      expect(openSpy).toHaveBeenCalledWith(
        expected.href,
        '_blank',
        'noopener,noreferrer',
      );
      // Unfavoriting doesn't save again.
      openSpy.mockClear();
      await user.keyboard('f');
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it('does not auto-save on favorite when auto-save is off (service chosen)', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(SAVE_SERVICE_KEY, 'raindrop');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      renderReader(source);
      await screen.findByTestId('reader-more');
      await user.keyboard('f');
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe('ItemPage comments button', () => {
  // Overlay fields onto the resolved item/feed so the reader sees a comments
  // link / HN discussion / HN feed the default seed (none are HN) doesn't carry.
  class CommentsSource extends MockDataSource {
    constructor(
      private readonly overrides: { item?: Partial<Item>; feed?: Partial<Feed> },
      key = `test-${Math.random()}`,
    ) {
      super(key);
    }
    async getItem(id: ItemId): Promise<FeedItem | null> {
      const fi = await super.getItem(id);
      if (!fi) return null;
      return {
        ...fi,
        item: { ...fi.item, ...this.overrides.item },
        feed: { ...fi.feed, ...this.overrides.feed },
      };
    }
  }

  it('hides the Comments button when the item has no comments URL', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    await screen.findByTestId('open-original');
    expect(screen.queryByTestId('reader-comments')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reader-comments-bottom')).not.toBeInTheDocument();
  });

  it('opens a non-Hacker-News comments URL directly, on both bars', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const source = new CommentsSource({
      item: { commentsUrl: 'https://example.com/blog/post/comments' },
    });
    renderReader(source);
    const top = await screen.findByTestId('reader-comments');
    expect(top).toHaveAttribute('aria-label', 'Comments');
    expect(screen.getByTestId('reader-comments-bottom')).toBeInTheDocument();
    await user.click(top);
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com/blog/post/comments',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('routes a comments URL that points at Hacker News to newshacker (same tab)', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const loc = mockLocationAssign();
    try {
      // A non-HN feed whose structured <comments> link is itself an HN thread.
      const source = new CommentsSource({
        item: { commentsUrl: 'https://news.ycombinator.com/item?id=42662903' },
      });
      renderReader(source);
      const top = await screen.findByTestId('reader-comments');
      expect(top).toHaveAttribute('aria-label', 'Comments on newshacker');
      await user.click(top);
      // newshacker (our sibling app) opens in the same tab (location.assign, no
      // new-tab hardening), so its Done/back returns to this reader.
      expect(loc.assign).toHaveBeenCalledWith(
        'https://newshacker.app/item/42662903',
      );
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      loc.restore();
      openSpy.mockRestore();
    }
  });

  it('does not label a newshacker.app look-alike host as "Comments on newshacker"', async () => {
    // Regression for PR #264 review: commentsUrl is publisher-controlled, so a
    // host that merely starts with the newshacker origin must be matched by
    // parsed origin, not a string prefix — labeled plain "Comments" and opened
    // verbatim.
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const source = new CommentsSource({
      item: { commentsUrl: 'https://newshacker.app.evil.example/thread' },
    });
    renderReader(source);
    const top = await screen.findByTestId('reader-comments');
    expect(top).toHaveAttribute('aria-label', 'Comments');
    await user.click(top);
    expect(openSpy).toHaveBeenCalledWith(
      'https://newshacker.app.evil.example/thread',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('derives the newshacker thread from the item body on a Hacker News feed', async () => {
    const user = userEvent.setup();
    const loc = mockLocationAssign();
    try {
      // Official HN feed: no structured comments URL — the discussion link lives
      // only in the description body, so the HN derivation must scan it.
      const source = new CommentsSource({
        feed: { siteUrl: 'https://news.ycombinator.com/' },
        item: {
          commentsUrl: null,
          contentHtml:
            '<p>Article. <a href="https://news.ycombinator.com/item?id=42662903">Comments</a></p>',
        },
      });
      renderReader(source);
      const top = await screen.findByTestId('reader-comments');
      expect(top).toHaveAttribute('aria-label', 'Comments on newshacker');
      await user.click(top);
      // Same-tab navigation to our sibling app (location.assign, no hardening).
      expect(loc.assign).toHaveBeenCalledWith(
        'https://newshacker.app/item/42662903',
      );
    } finally {
      loc.restore();
    }
  });

  it('does not show a Comments button on a non-HN feed whose body merely mentions HN', async () => {
    // Regression for PR #264 review: the HN id derivation scans the body, so a
    // normal feed article that links to an HN thread (no structured comments
    // URL of its own) must NOT sprout a newshacker button.
    const source = new CommentsSource({
      item: {
        commentsUrl: null,
        contentHtml:
          '<p>See the <a href="https://news.ycombinator.com/item?id=42662903">discussion</a>.</p>',
      },
    });
    renderReader(source);
    await screen.findByTestId('open-original');
    expect(screen.queryByTestId('reader-comments')).not.toBeInTheDocument();
  });

  it('moves Pin into the overflow menu on narrow when the Comments button is present', async () => {
    const user = userEvent.setup();
    const source = new CommentsSource({
      item: { commentsUrl: 'https://example.com/blog/post/comments' },
    });
    renderReader(source);
    const comments = await screen.findByTestId('reader-comments');
    // Pin is no longer an inline bar button on either bar — it made room for
    // Comments to keep the ≥320px single-row layout.
    expect(screen.queryByTestId('reader-pin')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reader-pin-bottom')).not.toBeInTheDocument();
    // The narrow inline cluster is open original → comments → done → more.
    const cluster = comments.closest('.reader__actions');
    const order = Array.from(cluster!.querySelectorAll('[data-testid]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(order).toEqual([
      'open-original',
      'reader-comments',
      'reader-done',
      'reader-more',
    ]);
    // Pin lives in the shared overflow menu instead, and still pins.
    await user.click(screen.getByTestId('reader-more'));
    const pin = await screen.findByTestId('item-row-menu-pin');
    expect(pin).toHaveTextContent('Pin');
    await user.click(pin);
    expect(source.stateStore.get('item-1').pinned).toBe(true);
  });

  it('keeps Pin inline on narrow when the item has no comments', async () => {
    // Regression: the Pin demotion is scoped to commented items, so a normal
    // item keeps Pin on the bar (main's Pin-inline design).
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    expect(await screen.findByTestId('reader-pin')).toBeInTheDocument();
    expect(screen.queryByTestId('reader-comments')).not.toBeInTheDocument();
  });

  it('opens comments with the "c" keyboard shortcut', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const source = new CommentsSource({
      item: { commentsUrl: 'https://example.com/blog/post/comments' },
    });
    renderReader(source);
    await screen.findByTestId('reader-comments');
    await user.keyboard('c');
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com/blog/post/comments',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });
});

describe('ItemPage navigation shortcuts', () => {
  it('b pops back to the previous page', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReaderWithHistory(source, { entries: ['/', '/item/item-1'] });
    await screen.findByTestId('open-original');

    await user.keyboard('b');
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent('/');
    });
  });

  it('b with no back entry closes the tab, then falls back to the home list', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    // Single entry, no back entry → try to close the tab, then fall back to '/'
    // rather than a no-op navigate(-1) that leaves the reader stuck.
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    renderReaderWithHistory(source, { entries: ['/item/item-1'] });
    await screen.findByTestId('open-original');

    await user.keyboard('b');
    expect(close).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent('/');
    });
  });

  it('u goes up to this item’s feed', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    // item-1 belongs to the Verge feed (feed-verge).
    renderReaderWithHistory(source, { entries: ['/item/item-1'] });
    await screen.findByTestId('open-original');

    await user.keyboard('u');
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent(
        '/feed/feed-verge',
      );
    });
    expect(screen.getByTestId('route-feed')).toBeInTheDocument();
  });
});

describe('ItemPage reading mode', () => {
  it('shows the RSS body first and reveals the full article via "Read more"', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    // The seed item-1 body is a short stub. The reader shows that feed body
    // immediately and fetches the full article in the background — WITHOUT
    // swapping it in automatically (no reflow mid-read).
    expect(await screen.findByText(/visible creases/)).toBeInTheDocument();
    const keepReading = await screen.findByTestId('reader-keep-reading');
    expect(keepReading).toHaveTextContent('Read more');
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

    // Back to the reading view via Read more on the mode bar.
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
    // Device has a connection (navigator.onLine stays true) and the backend
    // answered — with a 5xx, so it's reachable-but-erroring ("Down"). With no
    // cached copy to fall back to, the miss state must say the server is the
    // problem, not "pin it while online" (which would imply the user is offline).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await trackedFetch('/rest/v1/x');
    vi.unstubAllGlobals();
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
      // Capture the setter in an effect, not during render, so the test can
      // flip the restoration flag without reassigning an outer variable mid-render.
      useEffect(() => {
        finishRestoring = () => setRestoring(false);
      }, []);
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

  it('hides a cached reading body from an off-allowlist user', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // A reading body cached from before the allowlist was armed (or before the
    // user was removed).
    queryClient.setQueryData(['fulltext', 'item-1'], {
      status: 'ok',
      contentHtml: '<p>prefetched reading body</p>',
    });
    // The caller is now off an armed allowlist → no reading-mode access.
    queryClient.setQueryData(['capabilities'], {
      family: false,
      admin: false,
      allowlistArmed: true,
    });
    renderReader(new MockDataSource(`test-${Math.random()}`), 'item-1', queryClient);

    // The feed body shows; the cached reading body must NOT leak through.
    expect(await screen.findByText(/visible creases/)).toBeInTheDocument();
    expect(screen.queryByText(/prefetched reading body/)).not.toBeInTheDocument();
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

  it('stays silent for a retryable allowlist denial (no error note, feed body + open-original)', async () => {
    // A confirmed non-allowlisted caller gets a `retryable` empty — rendered
    // exactly like a genuine `empty` (silent feed-stub fallback), never an
    // alarming note or a "Try again" button (we don't advertise a feature they
    // can't use).
    class GatedSource extends MockDataSource {
      async fetchFullText(): Promise<FullTextResult> {
        return { status: 'empty', contentHtml: null, retryable: true };
      }
    }
    const source = new GatedSource(`test-${Math.random()}`);
    renderReader(source);

    await screen.findByText(/visible creases/);
    await waitFor(() =>
      expect(screen.queryByTestId('fulltext-loading')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('fulltext-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fulltext-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('fulltext-open-original')).toBeInTheDocument();
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
    // Recovered: reveal the full body via Read more (no auto-swap).
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

  it('flags a fallback-sourced reading body with "via fallback" after the source', async () => {
    const user = userEvent.setup();
    class FallbackSource extends MockDataSource {
      async fetchFullText(): Promise<FullTextResult> {
        return { status: 'ok', contentHtml: '<p>fallback full body</p>', viaFallback: true };
      }
    }
    renderReader(new FallbackSource(`test-${Math.random()}`));
    // The feed body shows first; the provenance tag only appears once the reader
    // is actually showing the fallback-sourced reading body.
    const keepReading = await screen.findByTestId('reader-keep-reading');
    expect(screen.queryByTestId('reader-via-fallback')).toBeNull();

    await user.click(keepReading);
    expect(await screen.findByText(/fallback full body/)).toBeInTheDocument();
    expect(screen.getByTestId('reader-via-fallback')).toHaveTextContent('via fallback');
  });

  it('shows no provenance tag for a directly-fetched reading body', async () => {
    const user = userEvent.setup();
    // The default mock omits viaFallback (a direct fetch).
    renderReader(new MockDataSource(`test-${Math.random()}`));
    await user.click(await screen.findByTestId('reader-keep-reading'));
    expect(await screen.findByText(/full article text/)).toBeInTheDocument();
    expect(screen.queryByTestId('reader-via-fallback')).toBeNull();
  });
});
