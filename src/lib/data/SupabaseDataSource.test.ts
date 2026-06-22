// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseDataSource } from './SupabaseDataSource';
import { makeFakeSupabase, type FakeTables } from './fakeSupabaseClient';

const recent = new Date('2026-06-20T00:00:00.000Z').toISOString();
function iso(day: number): string {
  return new Date(`2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`).toISOString();
}

function seed(): FakeTables {
  return {
    feeds_public: [
      { id: 'feed-a', site_url: 'https://a.example.com', title: 'Alpha Blog', error_count: 0, last_error: null, last_fetched_at: null, next_fetch_at: null, fetch_interval_s: 1800, created_at: null },
      { id: 'feed-b', site_url: 'https://b.example.com', title: 'Beta News', error_count: 0, last_error: null, last_fetched_at: null, next_fetch_at: null, fetch_interval_s: 1800, created_at: null },
      { id: 'feed-c', site_url: 'https://c.example.com', title: 'Gamma', error_count: 0, last_error: null, last_fetched_at: null, next_fetch_at: null, fetch_interval_s: 1800, created_at: null },
    ],
    subscriptions: [
      { feed_id: 'feed-a', folder: 'Tech', title_override: null, muted: false, sort: 0 },
      { feed_id: 'feed-b', folder: null, title_override: null, muted: false, sort: 1 },
      { feed_id: 'feed-c', folder: null, title_override: null, muted: true, sort: 2 },
    ],
    items: [
      mkItem('i1', 'feed-a', 1, 'Alpha one'),
      mkItem('i2', 'feed-a', 2, 'Alpha two'),
      mkItem('i3', 'feed-b', 3, 'Beta three'),
      mkItem('i4', 'feed-b', 4, 'Beta four'),
      mkItem('i5', 'feed-c', 5, 'Gamma five'),
      mkItem('i6', 'feed-a', 6, 'Alpha six'),
    ],
    item_state: [
      mkState('i2', { pinned: true, pinned_at: recent }),
      mkState('i4', { done: true, done_at: recent }),
      mkState('i1', { hidden: true, hidden_at: recent }),
    ],
    folders: [
      { name: 'Tech', sort: 0 },
    ],
  };
}

function mkItem(id: string, feed_id: string, day: number, title: string) {
  return {
    id, feed_id, guid: `g-${id}`, url: `https://x/${id}`, title, author: null,
    published_at: iso(day), content_html: `<p>${title}</p>`, summary: null,
    enclosures: [], content_hash: null, created_at: iso(day),
  };
}

function mkState(item_id: string, over: Record<string, unknown>) {
  return {
    user_id: 'u1', item_id,
    pinned: false, pinned_at: null, favorite: false, favorite_at: null,
    done: false, done_at: null, hidden: false, hidden_at: null,
    opened: false, opened_at: null, version: 1, ...over,
  };
}

function setup(tables: FakeTables = seed()) {
  const fake = makeFakeSupabase(tables);
  const ds = new SupabaseDataSource('readmo:item-state:test', fake.client as unknown as SupabaseClient);
  return { ds, fake };
}

const ids = (items: Array<{ item: { id: string } }>) => items.map((fi) => fi.item.id);

describe('SupabaseDataSource reads', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it('getHomeItems: excludes muted feeds, filters Done/Hidden, prepends Pinned (oldest-first)', async () => {
    const page = await env.ds.getHomeItems();
    // i2 pinned (top), then body newest-first: i6 (day 6), i3 (day 3).
    // i1 hidden + i4 done are excluded; feed-c is muted.
    expect(ids(page.items)).toEqual(['i2', 'i6', 'i3']);
    expect(page.total).toBe(3);
    expect(page.nextCursor).toBeNull();
  });

  it('getFeedItems: a single feed view includes a muted feed’s own items', async () => {
    const page = await env.ds.getFeedItems('feed-c');
    expect(ids(page.items)).toEqual(['i5']);
  });

  it('getFolderItems: scoped to the folder’s feeds', async () => {
    const page = await env.ds.getFolderItems('Tech');
    expect(ids(page.items)).toEqual(['i2', 'i6']); // feed-a only; i1 hidden
  });

  it('pages the COMBINED pinned+body sequence, bounded to limit per page', async () => {
    // Combined order is [i2 (pinned), i6, i3 (body, newest-first)]; each page
    // holds at most `limit` rows (pinned no longer dumped wholesale on page 1).
    const p1 = await env.ds.getHomeItems({ limit: 1 });
    expect(ids(p1.items)).toEqual(['i2']);
    expect(p1.total).toBe(3);
    expect(p1.nextCursor).toBe('1');

    const p2 = await env.ds.getHomeItems({ limit: 1, cursor: p1.nextCursor });
    expect(ids(p2.items)).toEqual(['i6']);
    expect(p2.nextCursor).toBe('2');

    const p3 = await env.ds.getHomeItems({ limit: 1, cursor: p2.nextCursor });
    expect(ids(p3.items)).toEqual(['i3']);
    expect(p3.nextCursor).toBeNull();
  });

  it('orders undated items by the created_at fallback (sort_at)', async () => {
    const tables = seed();
    // An undated item (null published_at) fetched most recently.
    tables.items.push({
      id: 'i-undated', feed_id: 'feed-b', guid: 'g-und', url: 'https://x/und',
      title: 'Undated latest', author: null, published_at: null,
      content_html: '', summary: null, enclosures: [], content_hash: null,
      created_at: iso(28),
    });
    const { ds } = setup(tables);
    const page = await ds.getHomeItems();
    // sort_at = published_at ?? created_at, so the undated item (day 28) sorts
    // above i6 (day 6) and i3 (day 3); i2 is the pinned prepend.
    expect(ids(page.items)).toEqual(['i2', 'i-undated', 'i6', 'i3']);
  });

  it('getItem / getItemsByIds map and preserve order', async () => {
    const one = await env.ds.getItem('i3');
    expect(one?.item.title).toBe('Beta three');
    expect(one?.feed.id).toBe('feed-b');

    const many = await env.ds.getItemsByIds(['i6', 'i1', 'i3']);
    expect(ids(many)).toEqual(['i6', 'i1', 'i3']);
  });

  it('getItemsByIds chunks a large id list (no unbounded IN)', async () => {
    const tables = seed();
    const big = Array.from({ length: 450 }, (_, i) => {
      const id = `big-${String(i).padStart(3, '0')}`;
      return mkItem(id, 'feed-a', 1, `Big ${i}`);
    });
    tables.items.push(...big);
    const { ds, fake } = setup(tables);
    const wanted = big.map((r) => r.id).reverse(); // arbitrary order to verify re-sort
    const got = await ds.getItemsByIds(wanted);
    expect(got).toHaveLength(450);
    expect(ids(got)).toEqual(wanted); // input order preserved across chunks
    expect(fake.selectCount('items')).toBe(3); // ceil(450 / 200) batched requests
  });

  it('chunks feed-metadata lookups across many feeds', async () => {
    const tables = seed();
    const N = 300;
    for (let i = 0; i < N; i++) {
      const fid = `mf-${String(i).padStart(3, '0')}`;
      tables.feeds_public.push({
        id: fid, site_url: `https://f${i}.example.com`, title: `Feed ${i}`,
        error_count: 0, last_error: null, last_fetched_at: null,
        next_fetch_at: null, fetch_interval_s: 1800, created_at: null,
      });
      tables.items.push(mkItem(`it-${String(i).padStart(3, '0')}`, fid, 1, `Item ${i}`));
    }
    const { ds, fake } = setup(tables);
    const wanted = Array.from({ length: N }, (_, i) => `it-${String(i).padStart(3, '0')}`);
    const got = await ds.getItemsByIds(wanted);
    expect(got).toHaveLength(N);
    expect(got.every((fi) => fi.feed.id.startsWith('mf-'))).toBe(true);
    // 300 distinct feeds + 300 ids => ceil(300/200) = 2 batched requests each.
    expect(fake.selectCount('feeds_public')).toBe(2);
    expect(fake.selectCount('items')).toBe(2);
  });

  it('getItem / getFeed return null for a missing/unauthorized row', async () => {
    expect(await env.ds.getItem('does-not-exist')).toBeNull();
    expect(await env.ds.getFeed('does-not-exist')).toBeNull();
  });

  it('hydrates item_state on the empty-ids path (cold library-route boot)', async () => {
    // A direct boot into /pinned etc.: ids are empty because no feed view has
    // hydrated the store. The empty-ids path must still fetch item_state.
    const items = await env.ds.getItemsByIds([]);
    expect(items).toEqual([]);
    const entries = Object.fromEntries(env.ds.stateStore.entries());
    expect(entries['i2']?.pinned).toBe(true);
    expect(entries['i4']?.done).toBe(true);
    expect(entries['i1']?.hidden).toBe(true);
  });

  it('search matches item title and feed title, deduped + newest-first', async () => {
    const results = await env.ds.search('alpha');
    expect(ids(results)).toEqual(['i6', 'i2', 'i1']);
  });

  it('getSubscriptions sorts by sort and surfaces mute state', async () => {
    const subs = await env.ds.getSubscriptions();
    expect(subs.map((s) => s.subscription.feedId)).toEqual(['feed-a', 'feed-b', 'feed-c']);
    expect(subs.find((s) => s.subscription.feedId === 'feed-c')?.subscription.muted).toBe(true);
  });

  it('getFolders returns ordered folders', async () => {
    expect(await env.ds.getFolders()).toEqual([{ name: 'Tech', sort: 0 }]);
  });

  it('getFeed sources the display url from site_url', async () => {
    const feed = await env.ds.getFeed('feed-b');
    expect(feed?.url).toBe('https://b.example.com');
    expect(feed?.title).toBe('Beta News');
  });
});

describe('SupabaseDataSource dispatch + writes', () => {
  it('writes item-state mutations through the set_item_state RPC (changed fields only)', async () => {
    const env = setup();
    await env.ds.getHomeItems(); // hydrate

    // Hiding i6 locally writes only the changed field through to the server...
    env.ds.stateStore.set('i6', 'hidden', true);
    await new Promise((r) => setTimeout(r)); // drain the per-item write chain
    // i6 had no server state, so the optimistic-concurrency base is 0 (expect
    // no row yet).
    expect(env.fake.rpcCalls).toContainEqual({
      name: 'set_item_state',
      params: { p_item_id: 'i6', p_hidden: true, p_base_version: 0 },
    });

    // ...so the next feed read (server truth via feed_items) no longer surfaces it.
    const page = await env.ds.getHomeItems();
    expect(ids(page.items)).not.toContain('i6');
  });

  it('overlays local optimistic state even before the write commits', async () => {
    const env = setup();
    await env.ds.getHomeItems(); // hydrate
    // Disable write-through so the server (fake) stays unchanged — simulating an
    // in-flight/slow set_item_state while useFeedItems refetches.
    env.ds.stateStore.setMutationSink(() => {});
    env.ds.stateStore.set('i6', 'hidden', true); // local only

    const page = await env.ds.getHomeItems();
    // The server RPC still returns i6, but the local overlay drops it.
    expect(ids(page.items)).not.toContain('i6');
  });

  it('discover invokes the edge function and maps candidates', async () => {
    const env = setup();
    env.fake.invokeResult.current = {
      data: {
        candidates: [
          { feedUrl: 'https://x.com/feed', title: 'X Feed', siteUrl: 'https://x.com', sample: [{ title: 'p1' }, { title: 'p2' }, { title: '' }] },
        ],
      },
      error: null,
    };
    const found = await env.ds.discover('x.com');
    expect(found).toEqual([
      { url: 'https://x.com/feed', title: 'X Feed', siteUrl: 'https://x.com', sampleTitles: ['p1', 'p2'] },
    ]);
    expect(env.fake.invokeCalls).toContainEqual({ name: 'discover', body: { url: 'x.com' } });
  });

  it('refresh invokes the edge function with the feed id', async () => {
    const env = setup();
    await env.ds.refresh('feed-a');
    expect(env.fake.invokeCalls).toContainEqual({ name: 'refresh', body: { feedId: 'feed-a' } });
  });

  it('refresh invalidates cached feed metadata', async () => {
    const env = setup();
    expect((await env.ds.getFeed('feed-a'))?.title).toBe('Alpha Blog');
    // A poll/refresh updated feeds_public server-side.
    env.fake.store.feeds_public.find((r) => r.id === 'feed-a')!.title = 'Alpha Renamed';
    await env.ds.refresh('feed-a');
    // The stale cache was dropped, so the next read reflects the server change.
    expect((await env.ds.getFeed('feed-a'))?.title).toBe('Alpha Renamed');
  });

  it('recovers hydration after a transient item_state failure', async () => {
    const fake = makeFakeSupabase(seed());
    fake.failSelectOnce('item_state'); // first (eager) hydration attempt errors
    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    // Let the failed eager hydration settle and clear itself.
    await new Promise((r) => setTimeout(r));
    expect(ds.stateStore.entries()).toHaveLength(0);
    // A subsequent read retries and succeeds instead of replaying the rejection.
    await ds.getItemsByIds([]);
    expect(Object.fromEntries(ds.stateStore.entries())['i2']?.pinned).toBe(true);
  });

  it('unsubscribe deletes the subscription row', async () => {
    const env = setup();
    await env.ds.unsubscribe('feed-a');
    const subs = await env.ds.getSubscriptions();
    expect(subs.map((s) => s.subscription.feedId)).toEqual(['feed-b', 'feed-c']);
  });

  it('setMuted / setTitleOverride update only their columns', async () => {
    const env = setup();
    await env.ds.setMuted('feed-b', true);
    await env.ds.setTitleOverride('feed-b', 'Custom');
    const subs = await env.ds.getSubscriptions();
    const b = subs.find((s) => s.subscription.feedId === 'feed-b')!;
    expect(b.subscription.muted).toBe(true);
    expect(b.subscription.titleOverride).toBe('Custom');
  });

  it('subscribe routes through subscribe_to_feed and triggers an immediate refresh', async () => {
    const env = setup();
    const feed = await env.ds.subscribe('https://new.example.com/feed', 'Tech');
    expect(env.fake.rpcCalls).toContainEqual({
      name: 'subscribe_to_feed',
      params: { p_url: 'https://new.example.com/feed', p_folder: 'Tech' },
    });
    expect(feed.id).toBe('feed-new');
    await Promise.resolve(); // let the fire-and-forget refresh dispatch
    // On-demand poll of the new feed (SPEC: adding a feed fetches immediately).
    expect(env.fake.invokeCalls).toContainEqual({ name: 'refresh', body: { feedId: 'feed-new' } });
    // Now subscribed + present in the list.
    const subs = await env.ds.getSubscriptions();
    expect(subs.map((s) => s.subscription.feedId)).toContain('feed-new');
  });

  it('importOpml subscribes each xmlUrl (entity-decoded), counting added vs already-subscribed', async () => {
    const env = setup();
    const xml = `<opml><body>
      <outline type="rss" xmlUrl="https://a.example.com" />
      <outline type="rss" xmlUrl="https://new.example.com/feed?a=1&amp;b=2" />
    </body></opml>`;
    // a.example.com resolves to feed-a (already subscribed) → skipped; the other
    // is new → added, and its &amp; is decoded before subscribing.
    const result = await env.ds.importOpml(xml);
    expect(result).toEqual({ added: 1, skipped: 1 });
    expect(env.fake.rpcCalls).toContainEqual({
      name: 'subscribe_to_feed',
      params: { p_url: 'https://new.example.com/feed?a=1&b=2', p_folder: null },
    });
  });

  it('serializes set_item_state writes for the same item (last action wins)', async () => {
    const env = setup();
    await env.ds.getHomeItems(); // hydrate
    env.ds.stateStore.set('i3', 'pinned', true);
    env.ds.stateStore.set('i3', 'pinned', false);
    // Let the per-item write chain drain.
    await new Promise((r) => setTimeout(r));
    const row = env.fake.store.item_state.find((s) => s.item_id === 'i3');
    expect(row?.pinned).toBe(false); // the later Unpin is applied last
  });

  it('retryParkedFeed re-polls via the refresh function', async () => {
    const env = setup();
    await env.ds.retryParkedFeed('feed-a');
    expect(env.fake.invokeCalls).toContainEqual({ name: 'refresh', body: { feedId: 'feed-a' } });
  });
});
