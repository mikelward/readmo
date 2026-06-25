// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { MockDataSource, PAGE_SIZE } from './MockDataSource';

function fresh(): MockDataSource {
  // Unique state key per test so localStorage (absent in node) and the
  // in-memory seed both start clean.
  return new MockDataSource(`test-${Math.random()}`);
}

describe('MockDataSource feed reads', () => {
  let ds: MockDataSource;
  beforeEach(() => {
    ds = fresh();
  });

  it('home excludes Done and Hidden items', async () => {
    const before = await ds.getHomeItems();
    const victim = before.items[0].item.id;
    ds.stateStore.set(victim, 'done', true);
    const after = await ds.getHomeItems();
    expect(after.items.find((fi) => fi.item.id === victim)).toBeUndefined();
    // The seed fits in a single page, so dropping one item shrinks it by one.
    expect(after.items.length).toBe(before.items.length - 1);
  });

  it('prepends Pinned items to the top, oldest-pinned first', async () => {
    const page = await ds.getHomeItems();
    const a = page.items[2].item.id;
    const b = page.items[4].item.id;
    ds.stateStore.set(a, 'pinned', true, 1000);
    ds.stateStore.set(b, 'pinned', true, 2000); // pinned later
    const after = await ds.getHomeItems();
    expect(after.items[0].item.id).toBe(a); // oldest pin first
    expect(after.items[1].item.id).toBe(b);
  });

  it('renders a pinned item once (not duplicated in the body)', async () => {
    const page = await ds.getHomeItems();
    const id = page.items[1].item.id;
    ds.stateStore.set(id, 'pinned', true);
    const after = await ds.getHomeItems();
    const count = after.items.filter((fi) => fi.item.id === id).length;
    expect(count).toBe(1);
  });

  it('excludes muted feeds from home but keeps them on their own page', async () => {
    await ds.setMuted('feed-verge', true);
    const home = await ds.getHomeItems();
    expect(home.items.some((fi) => fi.feed.id === 'feed-verge')).toBe(false);
    const feed = await ds.getFeedItems('feed-verge');
    expect(feed.items.length).toBeGreaterThan(0);
  });

  it('paginates with an explicit cursor', async () => {
    const page1 = await ds.getHomeItems({ limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).toBe('3');
    const page2 = await ds.getHomeItems({ limit: 3, cursor: page1.nextCursor });
    expect(page2.items[0].item.id).not.toBe(page1.items[0].item.id);
  });

  it('defaults to a 30-item page', () => {
    expect(PAGE_SIZE).toBe(30);
  });
});

describe('MockDataSource freshness window + per-feed floor', () => {
  // item-10 is on feed-css and ~5.8 days old (past the 3-day window). css has
  // only a few items, so the default floor (10) keeps it visible.
  it('keeps a quiet feed’s old items via the floor (fewer items than the floor)', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    const css = await ds.getFeedItems('feed-css', { limit: 100 });
    expect(css.items.map((fi) => fi.item.id)).toContain('item-10'); // old but kept
    const home = await ds.getHomeItems({ limit: 100 });
    expect(home.items.map((fi) => fi.item.id)).toContain('item-10');
  });

  it('drops out-of-window items once a feed exceeds the floor', async () => {
    // floor=1 → only each feed's single newest survives the age cut; older
    // out-of-window items fall away. css: item-3 (9h, in window) stays; item-10
    // (~140h, rank 2) is past both the window and the floor → dropped.
    const ds = new MockDataSource(`test-${Math.random()}`, { feedFloor: 1 });
    const css = await ds.getFeedItems('feed-css', { limit: 100 });
    const ids = css.items.map((fi) => fi.item.id);
    expect(ids).toContain('item-3'); // newest, also within the window
    expect(ids).not.toContain('item-10'); // past window + beyond floor
  });

  it('keeps a pinned item regardless of window or floor', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`, { feedFloor: 1 });
    ds.stateStore.set('item-10', 'pinned', true); // old css item, beyond floor=1
    const home = await ds.getHomeItems({ limit: 100 });
    const ids = home.items.map((fi) => fi.item.id);
    expect(ids[0]).toBe('item-10'); // pinned section, at the top
  });

  it('a dismissed item does not occupy a floor slot', async () => {
    // With floor=1, marking the newest css item done lets the next one take the
    // floor slot (the floor ranks only non-dismissed items).
    const ds = new MockDataSource(`test-${Math.random()}`, { feedFloor: 1 });
    ds.stateStore.set('item-3', 'done', true); // css newest → dismissed
    const css = await ds.getFeedItems('feed-css', { limit: 100 });
    const ids = css.items.map((fi) => fi.item.id);
    expect(ids).not.toContain('item-3'); // dismissed
    expect(ids).toContain('item-6'); // 30h, in window anyway, now the floor rank-0
  });
});

describe('MockDataSource getFeedUnreadCounts', () => {
  const FEEDS = ['feed-verge', 'feed-nasa', 'feed-css', 'feed-reddit-prog'];

  it('counts each feed’s listable items, all unread by default', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    expect(await ds.getFeedUnreadCounts(FEEDS)).toEqual({
      'feed-verge': 3,
      'feed-nasa': 2,
      'feed-css': 3,
      'feed-reddit-prog': 2,
    });
  });

  it('excludes Opened, Done, and active Hidden items', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    ds.stateStore.set('item-1', 'opened', true); // verge
    ds.stateStore.set('item-5', 'done', true); // verge
    const counts = await ds.getFeedUnreadCounts(['feed-verge']);
    // verge had item-1/5/9; opened + done drop out, leaving item-9.
    expect(counts['feed-verge']).toBe(1);
  });

  it('still counts a pinned item even when it has been opened (a pin is a to-do)', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    ds.stateStore.set('item-9', 'pinned', true); // verge, pinned
    ds.stateStore.set('item-9', 'opened', true); // …and read
    // item-9 is pinned, so it counts despite being opened; item-1/5 unread → 3.
    expect((await ds.getFeedUnreadCounts(['feed-verge']))['feed-verge']).toBe(3);
  });

  it('returns 0 for a feed with nothing unread', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    // feed-park has no items in the seed.
    expect((await ds.getFeedUnreadCounts(['feed-park']))['feed-park']).toBe(0);
  });
});

describe('MockDataSource library + subscriptions', () => {
  it('resolves ids for library views preserving order', async () => {
    const ds = fresh();
    const items = await ds.getItemsByIds(['item-3', 'item-1']);
    expect(items.map((fi) => fi.item.id)).toEqual(['item-3', 'item-1']);
  });

  it('subscribe adds a feed and a subscription', async () => {
    const ds = fresh();
    const feed = await ds.subscribe('https://blog.example.com/feed');
    const subs = await ds.getSubscriptions();
    expect(subs.some((s) => s.feed.id === feed.id)).toBe(true);
  });

  it('round-trips OPML export → import', async () => {
    const ds = fresh();
    const xml = await ds.exportOpml();
    const result = await ds.importOpml(xml);
    expect(result.added).toBe(0); // all already present
    expect(result.skipped).toBeGreaterThan(0);
  });

  it('search matches titles and feed names', async () => {
    const ds = fresh();
    const byTitle = await ds.search('foldable');
    expect(byTitle.length).toBeGreaterThan(0);
    const byFeed = await ds.search('NASA');
    expect(byFeed.length).toBeGreaterThan(0);
  });

  it('getFeed applies title_override from the subscription', async () => {
    const ds = fresh();
    await ds.setTitleOverride('feed-verge', 'My Verge');
    const feed = await ds.getFeed('feed-verge');
    expect(feed?.title).toBe('My Verge');
  });

  it('getFeed returns the raw feed title when title_override is null', async () => {
    const ds = fresh();
    const feed = await ds.getFeed('feed-verge');
    expect(feed?.title).not.toBeNull();
    expect(feed?.title).not.toBe(''); // has a real seed title
  });

  it('getFeedItems applies title_override in FeedItem.feed so item-row labels show the display name', async () => {
    const ds = fresh();
    await ds.setTitleOverride('feed-verge', 'Verge Renamed');
    const page = await ds.getFeedItems('feed-verge');
    expect(page.items.length).toBeGreaterThan(0);
    for (const fi of page.items) {
      expect(fi.feed.title).toBe('Verge Renamed');
    }
  });
});

describe('MockDataSource fetchFullText', () => {
  it('returns an expanded reading-mode body and caches it on the item', async () => {
    const ds = fresh();
    const first = await ds.fetchFullText('item-1');
    expect(first.status).toBe('ok');
    expect(first.contentHtml).toContain('full article text');

    // Cached on the shared item, so a re-read carries it and a second fetch is
    // served from cache (identical body).
    const fi = await ds.getItem('item-1');
    expect(fi?.item.fullContentHtml).toBe(first.contentHtml);
    const second = await ds.fetchFullText('item-1');
    expect(second.contentHtml).toBe(first.contentHtml);
  });

  it('reports unreachable for an unknown item', async () => {
    const ds = fresh();
    expect(await ds.fetchFullText('nope')).toEqual({
      status: 'unreachable',
      contentHtml: null,
    });
  });
});

describe('MockDataSource sort order', () => {
  // Seed publish order (newest→oldest): item-1 … item-10 (see seed.ts).
  it('defaults to newest-first', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    const page = await ds.getHomeItems();
    const idx = (id: string) => page.items.findIndex((fi) => fi.item.id === id);
    expect(idx('item-1')).toBeLessThan(idx('item-10'));
  });

  it('sorts oldest-first when asked, across pages', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    const all = await ds.getHomeItems({ sort: 'oldest', limit: 100 });
    const ids = all.items.map((fi) => fi.item.id);
    // Oldest (item-10) first, newest (item-1) last.
    expect(ids[0]).toBe('item-10');
    expect(ids[ids.length - 1]).toBe('item-1');
    // Pagination respects the order: page 1 starts at the oldest.
    const p1 = await ds.getHomeItems({ sort: 'oldest', limit: 3 });
    expect(p1.items[0].item.id).toBe('item-10');
  });

  it('keeps pinned at the global top regardless of sort order', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    ds.stateStore.set('item-1', 'pinned', true, 1000); // newest item, pinned
    const oldest = await ds.getHomeItems({ sort: 'oldest', limit: 100 });
    // Even oldest-first, the pinned item leads (pinned section is independent).
    expect(oldest.items[0].item.id).toBe('item-1');
  });
});

describe('MockDataSource group by feed', () => {
  const order = async (ds: MockDataSource, opts = {}) =>
    (await ds.getHomeItems({ groupByFeed: true, limit: 100, ...opts })).items.map(
      (fi) => fi.item.id,
    );

  it('sections items by feed in subscription order, newest-first within a feed', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    // Subscription order: verge(0) nasa(1) css(2) reddit(3).
    expect(await order(ds)).toEqual([
      'item-1', 'item-5', 'item-9', // verge, newest-first
      'item-2', 'item-7', // nasa
      'item-3', 'item-6', 'item-10', // css
      'item-4', 'item-8', // reddit-prog
    ]);
  });

  it('applies the sort order within each feed section', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    expect(await order(ds, { sort: 'oldest' })).toEqual([
      'item-9', 'item-5', 'item-1', // verge, oldest-first
      'item-7', 'item-2', // nasa
      'item-10', 'item-6', 'item-3', // css
      'item-8', 'item-4', // reddit-prog
    ]);
  });

  it('puts a feed’s pinned items at the top of that feed’s section, not a global top', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    ds.stateStore.set('item-9', 'pinned', true, 1000); // verge, oldest verge item
    const ids = await order(ds);
    // item-9 leads the verge section (not the whole list), then verge body.
    expect(ids.slice(0, 3)).toEqual(['item-9', 'item-1', 'item-5']);
    // nasa section still starts where it did.
    expect(ids.indexOf('item-2')).toBeLessThan(ids.indexOf('item-7'));
  });

  it('follows a reordered feed order', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    await ds.reorderSubscriptions([
      'feed-css', 'feed-verge', 'feed-nasa', 'feed-reddit-prog', 'feed-park',
    ]);
    const ids = await order(ds);
    // css now leads.
    expect(ids.slice(0, 3)).toEqual(['item-3', 'item-6', 'item-10']);
  });
});

describe('MockDataSource reorderSubscriptions', () => {
  it('reassigns sort to match the given order', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    await ds.reorderSubscriptions([
      'feed-nasa', 'feed-verge', 'feed-css', 'feed-reddit-prog', 'feed-park',
    ]);
    const subs = await ds.getSubscriptions();
    expect(subs.map((s) => s.feed.id)).toEqual([
      'feed-nasa', 'feed-verge', 'feed-css', 'feed-reddit-prog', 'feed-park',
    ]);
    expect(subs.map((s) => s.subscription.sort)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps an unnamed subscription after the listed ones', async () => {
    const ds = new MockDataSource(`test-${Math.random()}`);
    // Omit feed-park; it should fall to the end, not vanish.
    await ds.reorderSubscriptions([
      'feed-css', 'feed-verge', 'feed-nasa', 'feed-reddit-prog',
    ]);
    const subs = await ds.getSubscriptions();
    expect(subs[0].feed.id).toBe('feed-css');
    expect(subs[subs.length - 1].feed.id).toBe('feed-park');
  });
});
