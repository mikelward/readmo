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
    expect(after.total).toBe(before.total - 1);
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
});
