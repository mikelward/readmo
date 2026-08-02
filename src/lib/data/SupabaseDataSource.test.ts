// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { SupabaseDataSource } from './SupabaseDataSource';
import { _resetNetworkStatusForTests, setConnectivityProbeUrl } from '../networkStatus';
import { makeFakeSupabase, type FakeTables } from './fakeSupabaseClient';

// 5 days ago — always inside the 30-day Done/Hidden TTL. A fixed calendar
// date would silently expire as the wall clock advances and flip every
// fixture that expects i1/i4 filtered (the fake mirrors the RPC's
// wall-clock TTL), failing the suite by date alone.
const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
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
  const row: Record<string, unknown> = {
    user_id: 'u1', item_id,
    pinned: false, pinned_at: null, favorite: false, favorite_at: null,
    done: false, done_at: null, hidden: false, hidden_at: null,
    opened: false, opened_at: null, ...over,
  };
  // 0070's cursor column, defaulted the way the migration backfills it: the
  // newest of the five per-field clocks. Tests that care set it explicitly.
  if (row.updated_at === undefined) {
    const clocks = ['pinned_at', 'favorite_at', 'done_at', 'hidden_at', 'opened_at']
      .map((k) => row[k])
      .filter((v): v is string => typeof v === 'string');
    row.updated_at = clocks.length
      ? clocks.reduce((a, b) => (a > b ? a : b))
      : new Date(0).toISOString();
  }
  return row;
}

function setup(tables: FakeTables = seed()) {
  const fake = makeFakeSupabase(tables);
  const ds = new SupabaseDataSource('readmo:item-state:test', fake.client as unknown as SupabaseClient);
  return { ds, fake };
}

const ids = (items: Array<{ item: { id: string } }>) => items.map((fi) => fi.item.id);

/** Build an item_state read stub that mirrors the data source's keyset hydrate
 * chain (select → order → limit → [gt] → not, then awaited). `resolve` supplies
 * the awaited `{ data, count, error }` result. The real read pages by item_id;
 * these stubs return their whole (well-under-cap) snapshot on the first page, so
 * a single page is read (short page → no `.gt()` follow-up) and the loop ends. */
/** Wrap an `item_state` interceptor so the high-water probe — the only read
 * selecting the bare cursor column — passes through to the real fake instead of
 * the test's stub, and does NOT advance the test's read counter.
 *
 * The probe is only identifiable at `.select()` time, but these interceptors
 * count (and gate) at `from()` time, so without this every gated test would hold
 * the probe open instead of the page read it meant to hold. Building the inner
 * interceptor lazily keeps its counting tied to real page reads. */
function withProbePassthrough<T>(
  realFrom: (table: string) => unknown,
  inner: (table: string) => unknown,
): T {
  return ((table: string) => {
    if (table !== 'item_state') return inner(table);
    let built: { select: (c?: string, o?: unknown) => unknown } | null = null;
    return {
      select: (cols?: string, opts?: unknown) => {
        if (cols === 'updated_at') {
          return (
            realFrom('item_state') as { select: (c?: string, o?: unknown) => unknown }
          ).select(cols, opts);
        }
        built ??= inner(table) as { select: (c?: string, o?: unknown) => unknown };
        return built.select(cols, opts);
      },
    };
  }) as T;
}

function itemStateReadStub(resolve: () => unknown): unknown {
  const chain = {
    select: () => chain,
    or: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    gt: () => chain,
    not: () => Promise.resolve(resolve()),
  };
  return chain;
}

/** Flush microtasks until the outbox has fully drained (no write queued or in
 * flight) — an explicit drain-completion signal, so a test never depends on a
 * fixed number of timer ticks to know a write has committed and left the outbox.
 * Bounded so a write that never drains fails loudly instead of hanging. The fake
 * RPC resolves the server write synchronously before the send clears the entry,
 * so an empty outbox also means the server row reflects the write. */
async function drainOutbox(ds: { pendingItemIds(): ReadonlySet<string> }): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (ds.pendingItemIds().size === 0) return;
    await Promise.resolve();
  }
  throw new Error('outbox did not drain');
}

describe('SupabaseDataSource reads', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it('getLastSyncedAt is null until the first server pull, then a timestamp', async () => {
    // The constructor kicks off a boot hydration (`void ensureHydrated()`), so
    // the "null" window is the synchronous instant right after construction,
    // before that pull's microtask resolves. Read it inline here — no await
    // between construction and the assertion — rather than off the `env` built
    // in beforeEach, whose boot pull vitest has already flushed by the time the
    // body runs.
    const { ds } = setup();
    expect(ds.getLastSyncedAt()).toBeNull();
    await ds.getHomeItems(); // awaits the first hydration to completion
    expect(typeof ds.getLastSyncedAt()).toBe('number');
  });

  it('re-serves an item whose Done aged past the 30-day TTL (matching the real feed_items)', async () => {
    // Regression (test-double gap): the fake filtered Done items forever,
    // while the deployed feed_items RPC (0031) only drops a Done row for 30
    // days — Done is a 30-day completion log (SPEC *Retention*), after which
    // the item re-enters the feed body.
    const tables = seed();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    tables.item_state = [mkState('i4', { done: true, done_at: old })];
    const stale = setup(tables);
    const page = await stale.ds.getHomeItems();
    expect(ids(page.items)).toContain('i4');
  });

  it('keeps filtering a Done row with no done_at (SQL NULL semantics)', async () => {
    // `coalesce(done,false) and done_at > now() - 30d` is NULL for a null
    // timestamp, and the body's `not is_done` drops a NULL row — a
    // timestamp-less fixture must not surface just because the TTL can't be
    // evaluated.
    const tables = seed();
    tables.item_state = [mkState('i4', { done: true, done_at: null })];
    const stale = setup(tables);
    const page = await stale.ds.getHomeItems();
    expect(ids(page.items)).not.toContain('i4');
  });

  it('getHomeItems: excludes muted feeds, filters Done/Hidden, prepends Pinned (oldest-first)', async () => {
    const page = await env.ds.getHomeItems();
    // i2 pinned (top), then body newest-first: i6 (day 6), i3 (day 3).
    // i1 hidden + i4 done are excluded; feed-c is muted.
    expect(ids(page.items)).toEqual(['i2', 'i6', 'i3']);
    // 3 rows < the default limit (30), so the page is short → no next cursor.
    expect(page.nextCursor).toBeNull();
  });

  it('getHomeItems: keeps a pinned row even when it is also Done (pin exempt from the overlay drop)', async () => {
    // A pinned-then-Done row (e.g. pinned, then opened on a mark-done-on-open
    // feed) is returned by the server's pinned branch regardless of Done, so the
    // local overlay must NOT drop it — it stays, lifted to the pinned top block.
    // Without the pin exemption it vanished from the flat river.
    const tables = seed();
    tables.item_state = [
      mkState('i2', { pinned: true, pinned_at: recent, done: true, done_at: recent }),
      mkState('i1', { hidden: true, hidden_at: recent }),
    ];
    const local = setup(tables);
    const page = await local.ds.getHomeItems();
    expect(ids(page.items)).toContain('i2');
    expect(ids(page.items)[0]).toBe('i2'); // pinned → top of the river
  });

  it('getFeedItems: a single feed view includes a muted feed’s own items', async () => {
    const page = await env.ds.getFeedItems('feed-c');
    expect(ids(page.items)).toEqual(['i5']);
  });

  it('getFolderItems: scoped to the folder’s feeds', async () => {
    const page = await env.ds.getFolderItems('Tech');
    expect(ids(page.items)).toEqual(['i2', 'i6']); // feed-a only; i1 hidden
  });

  it('throws a descriptive error when feed_items returns the wrong row shape', async () => {
    // If the deployed function returns rows missing `id` (e.g. a completely
    // different schema), the shape guard must surface a clear error rather than
    // a cryptic downstream crash.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = setup();
    bad.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name !== 'feed_items') return bad.fake.client.rpc(name, params);
      void params;
      return Promise.resolve({ data: [{ wrong_field: 'oops' }], error: null });
    }) as typeof bad.fake.client.rpc;
    await expect(bad.ds.getHomeItems()).rejects.toThrow(/feed_items returned rows missing/i);
    errSpy.mockRestore();
  });
  it('pages the COMBINED pinned+body sequence, bounded to limit per page', async () => {
    // Combined order is [i2 (pinned), i6, i3 (body, newest-first)]; each page
    // holds at most `limit` rows (pinned no longer dumped wholesale on page 1).
    const p1 = await env.ds.getHomeItems({ limit: 1 });
    expect(ids(p1.items)).toEqual(['i2']);
    expect(p1.nextCursor).toBe('1');

    const p2 = await env.ds.getHomeItems({ limit: 1, cursor: p1.nextCursor });
    expect(ids(p2.items)).toEqual(['i6']);
    expect(p2.nextCursor).toBe('2');

    // Without a total count, "more?" is inferred from a full page. The third
    // page is still full (1 row == limit), so a cursor is offered even though
    // the sequence is exhausted...
    const p3 = await env.ds.getHomeItems({ limit: 1, cursor: p2.nextCursor });
    expect(ids(p3.items)).toEqual(['i3']);
    expect(p3.nextCursor).toBe('3');

    // ...and the next fetch comes back empty, which ends the pagination.
    const p4 = await env.ds.getHomeItems({ limit: 1, cursor: p3.nextCursor });
    expect(ids(p4.items)).toEqual([]);
    expect(p4.nextCursor).toBeNull();
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

  it('getItem does not read the gated full_content_html column', async () => {
    // Reading-mode bodies are served only through the allowlist-gated `fulltext`
    // function; a direct column read would leak a cached full article to any
    // subscriber who can see the item, bypassing the gate (PR #231 review).
    const env = setup();
    await env.ds.getItem('i3');
    expect(env.fake.lastSelectCols('items')).not.toContain('full_content_html');
  });

  it('reads comments_url and maps it onto the item (reader Comments button)', async () => {
    const tables = seed();
    tables.items.push({
      ...mkItem('i-hn', 'feed-a', 7, 'HN story'),
      comments_url: 'https://news.ycombinator.com/item?id=42662903',
    });
    const { ds, fake } = setup(tables);
    const fi = await ds.getItem('i-hn');
    expect(fake.lastSelectCols('items')).toContain('comments_url');
    expect(fi?.item.commentsUrl).toBe('https://news.ycombinator.com/item?id=42662903');
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
    // 'does-not-exist' is unseeded, so the direct items read is null AND the
    // get_shared_item fallback rpc is unknown to the fake (PGRST202) — exercising
    // loadSharedItem's degrade-to-null (old-backend / no-shared-item) path.
    expect(await env.ds.getItem('does-not-exist')).toBeNull();
    expect(await env.ds.getFeed('does-not-exist')).toBeNull();
  });

  it('getItem falls back to get_shared_item for a shared public-feed link', async () => {
    // The item isn't in the caller's visible rows (unseeded here = RLS-hidden for
    // a non-subscriber), so the direct read is null and getItem resolves it via
    // the get_shared_item RPC — the capability-by-URL shared open (0068).
    const sharedRow = {
      id: 'shared-1', feed_id: 'f-shared', guid: 'g-shared',
      url: 'https://public.example/story', comments_url: null,
      title: 'Shared Story', spoiler_free_title: null, author: 'A',
      published_at: null, content_html: '<p>shared body</p>', summary: null,
      enclosures: [], content_hash: null, created_at: '2026-01-01T00:00:00Z',
      feed_site_url: 'https://public.example', feed_title: 'Public Feed',
      feed_favicon_url: 'https://public.example/icon.png',
      feed_last_fetched_at: null, feed_next_fetch_at: null,
      feed_fetch_interval_s: 1800, feed_error_count: 0, feed_last_error: null,
      feed_created_at: null,
    };
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_shared_item' && params?.p_item_id === 'shared-1') {
        return Promise.resolve({ data: [sharedRow], error: null });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;

    const fi = await env.ds.getItem('shared-1');
    expect(fi?.item.id).toBe('shared-1');
    expect(fi?.item.contentHtml).toBe('<p>shared body</p>');
    // Feed metadata came from the RPC row (no feeds_public read for a
    // non-subscriber), so the reader can still show the feed name + favicon.
    expect(fi?.feed.title).toBe('Public Feed');
    expect(fi?.feed.faviconUrl).toBe('https://public.example/icon.png');
    // The gated full body never rides this path — it arrives via fetchFullText.
    expect(fi?.item.fullContentHtml).toBeNull();
  });

  it('getItem: shared-item fallback swallows an old backend (PGRST202) but throws other RPC errors', async () => {
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    // Old backend without the function → treated as a miss (reader shows its
    // normal not-found state), NOT an error to retry.
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_shared_item') {
        return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.getItem('missing-shared')).toBeNull();

    // A transient PostgREST/DB error must THROW so React Query retries, instead
    // of a false "article missing" the caller can't recover from.
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_shared_item') {
        return Promise.resolve({ data: null, error: { code: 'PGRST301', message: 'db blip' }, status: 503 });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    await expect(env.ds.getItem('missing-shared-2')).rejects.toThrow('db blip');
  });

  it('hydrates item_state on the empty-ids path (cold library-route boot)', async () => {
    // A direct boot into /pinned etc.: ids are empty because no feed view has
    // hydrated the store. The empty-ids path must still fetch item_state.
    const items = await env.ds.getItemsByIds([]);
    expect(items).toEqual([]);
    const entries = Object.fromEntries(env.ds.stateStore.entries());
    expect(entries['i2']?.pinned).toBe(true);
    expect(entries['i4']?.done).toBe(true);
    // i1 had hidden=true/done=false — hydrate migrates it to done=true/hidden=false
    expect(entries['i1']?.done).toBe(true);
    expect(entries['i1']?.hidden).toBe(false);
  });

  it('resyncState re-pulls item_state and adopts another device’s pin', async () => {
    // Boot hydration ran once (eager in the constructor) — i6 is not pinned yet.
    await env.ds.getItemsByIds([]);
    expect(Object.fromEntries(env.ds.stateStore.entries())['i6']?.pinned).toBeFalsy();
    const before = env.fake.selectCount('item_state');

    // Another device pins i6: the server item_state row appears.
    env.fake.store.item_state.push(mkState('i6', { pinned: true, pinned_at: recent }));

    // A focus/visibility/online tick calls resyncState, which re-pulls.
    await env.ds.resyncState();

    expect(env.fake.selectCount('item_state')).toBe(before + 1);
    expect(Object.fromEntries(env.ds.stateStore.entries())['i6']?.pinned).toBe(true);
  });

  it('serializes a resync started during an in-flight boot read so the fresher snapshot wins', async () => {
    // The boot item_state read is slow and still in flight when a focus tick
    // fires resyncState. Hydrations are SERIALIZED: the resync read runs only
    // after the boot read finishes, so it applies last and its post-pin snapshot
    // wins. The older boot snapshot can't clobber the adopted pin — and freshness
    // never depends on which request the *server* happened to execute first.
    const fake = makeFakeSupabase(seed());
    const realFrom = fake.client.from.bind(fake.client);
    let releaseBoot: () => void = () => {};
    // Signals exactly when the boot read is issued, so the test can push the pin
    // only after the boot snapshot is captured — explicit ordering, no timers.
    let bootStartedResolve!: () => void;
    const bootStarted = new Promise<void>((r) => (bootStartedResolve = r));
    let itemStateReads = 0;
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      itemStateReads++;
      // Snapshot the rows at request time (server semantics): the boot read
      // captures the pre-pin state, the resync read the post-pin state.
      const settle = {
        data: (fake.store.item_state ?? []).map((r) => ({ ...r })),
        count: null,
        error: null,
      };
      if (itemStateReads === 1) {
        // Boot read: held open until the test releases it.
        const bootRead = new Promise<typeof settle>((res) => {
          releaseBoot = () => res(settle);
        });
        bootStartedResolve();
        return itemStateReadStub(() => bootRead) as ReturnType<typeof realFrom>;
      }
      // Resync read: resolves immediately with the updated snapshot.
      return itemStateReadStub(() => settle) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await bootStarted; // the boot read has captured its (pre-pin) snapshot and parked
    expect(itemStateReads).toBe(1);
    // Another device pins i6 — only the later resync read will see it.
    fake.store.item_state.push(mkState('i6', { pinned: true, pinned_at: recent }));
    // A focus tick resyncs. Serialized behind the parked boot read, so its read
    // has NOT fired yet (this is the proof of serialization — a concurrent model
    // would have issued read 2 already).
    const resync = ds.resyncState();
    expect(itemStateReads).toBe(1);
    // Release the boot read: it applies its pre-pin snapshot first, THEN the
    // resync read runs and applies the post-pin snapshot last.
    releaseBoot();
    await resync;
    expect(itemStateReads).toBe(2);
    expect(Object.fromEntries(ds.stateStore.entries())['i6']?.pinned).toBe(true);
  });

  it('preserves an unpin+sweep made while a resync read is in flight (no resurrect as pinned)', async () => {
    // Regression: a resync (focus/visibility) read parks holding the pre-unpin
    // server snapshot; the user unpins THEN sweeps the item; then the stale read
    // lands carrying the still-pinned row. The local unpin/sweep stamped newer
    // `<f>At` clocks than that snapshot, so per-field LWW keeps them and the swept
    // item does NOT resurface pinned — even though the writes already drained from
    // the outbox by the time the read returns.
    const fake = makeFakeSupabase(seed()); // i2 is pinned in the seed
    const realFrom = fake.client.from.bind(fake.client);
    let releaseResync: () => void = () => {};
    let resyncStartedResolve!: () => void;
    const resyncStarted = new Promise<void>((r) => (resyncStartedResolve = r));
    let reads = 0;
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      reads += 1;
      // Snapshot the rows at request time (server semantics).
      const settle = {
        data: (fake.store.item_state ?? []).map((r) => ({ ...r })),
        count: null,
        error: null,
      };
      if (reads === 2) {
        // The resync read: capture the (still-pinned) snapshot, then park.
        const held = new Promise<typeof settle>((res) => {
          releaseResync = () => res(settle);
        });
        resyncStartedResolve();
        return itemStateReadStub(() => held) as ReturnType<typeof realFrom>;
      }
      return itemStateReadStub(() => settle) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.getItemsByIds([]); // settle the boot hydration → store holds i2 pinned
    expect(ds.stateStore.get('i2').pinned).toBe(true);

    const resync = ds.resyncState();
    await resyncStarted; // resync read parked, holding the pre-unpin snapshot

    // Unpin then sweep; wait until both writes have committed and left the
    // outbox (explicit drain signal, not a fixed number of timer ticks).
    ds.stateStore.set('i2', 'pinned', false);
    ds.stateStore.hideMany(['i2']);
    await drainOutbox(ds);
    const serverRow = (fake.store.item_state ?? []).find((r) => r.item_id === 'i2');
    expect(serverRow?.pinned).toBe(false);
    expect(serverRow?.done).toBe(true);

    // The stale resync read lands and the hydration applies (resyncState resolves
    // only after the hydrate has been applied).
    releaseResync();
    await resync;

    expect(ds.stateStore.get('i2').pinned).toBe(false);
    expect(ds.stateStore.get('i2').done).toBe(true);
  });

  it('keeps a pin made over a stale mirror consistent (not pinned+done) through a resync', async () => {
    // Scenario: another device marked i2 Done; this tab's mirror hasn't learned
    // that yet. A resync read parks holding the (Done) server snapshot; the user
    // pins the still-rendered row, then the stale read lands carrying done=true.
    // Because applyMutation stamps the pin's exclusivity-cleared done=false with
    // the SAME action clock, the local row's doneAt is as new as its pinnedAt, so
    // per-field LWW keeps BOTH (pinned=true, done=false) over the older server
    // row — no invalid pinned+done.
    const baseSeed = seed();
    baseSeed.item_state = []; // boot sees no state for i2 → local mirror clean
    const fake = makeFakeSupabase(baseSeed);
    const realFrom = fake.client.from.bind(fake.client);
    let releaseResync: () => void = () => {};
    let resyncStartedResolve!: () => void;
    const resyncStarted = new Promise<void>((r) => (resyncStartedResolve = r));
    let reads = 0;
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      reads += 1;
      const settle = {
        data: (fake.store.item_state ?? []).map((r) => ({ ...r })),
        count: null,
        error: null,
      };
      if (reads === 2) {
        const held = new Promise<typeof settle>((res) => {
          releaseResync = () => res(settle);
        });
        resyncStartedResolve();
        return itemStateReadStub(() => held) as ReturnType<typeof realFrom>;
      }
      return itemStateReadStub(() => settle) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.getItemsByIds([]); // settle the boot hydration (i2 has no state)
    expect(ds.stateStore.get('i2').done).toBe(false);

    // Another device marks i2 Done — older than the pin to come, so the pin's
    // exclusivity clear wins LWW on the server.
    const olderIso = new Date(Date.now() - 86_400_000).toISOString();
    (fake.store.item_state ??= []).push(mkState('i2', { done: true, done_at: olderIso }));

    const resync = ds.resyncState();
    await resyncStarted; // resync read parked, holding the Done snapshot

    // Pin the still-rendered (locally not-Done) row during the read; wait for the
    // write to commit and leave the outbox (explicit drain signal, not timer ticks).
    ds.stateStore.set('i2', 'pinned', true);
    await drainOutbox(ds);
    const serverRow = (fake.store.item_state ?? []).find((r) => r.item_id === 'i2');
    expect(serverRow?.pinned).toBe(true);
    expect(serverRow?.done).toBe(false); // the pin's closed write cleared Done

    releaseResync();
    await resync;

    expect(ds.stateStore.get('i2').pinned).toBe(true);
    expect(ds.stateStore.get('i2').done).toBe(false); // not left pinned+done
  });

  it('adopts server truth for a during-read write that LOST LWW (newer server clock wins)', async () => {
    // A write made during a resync read whose server value is NEWER (another
    // device's pin) must not stick. The parked read carries that winning server
    // row (pinned=true with the newer clock); per-field LWW compares it against
    // the local unpin's older clock and adopts the server — directly, without
    // needing the lwwLossPending re-pull (held open here to prove the read alone
    // reconciles correctly).
    const baseSeed = seed();
    // Another device pinned i2 with a timestamp NEWER than our clock, so this
    // tab's unpin will lose LWW on the server.
    const futureIso = new Date(Date.now() + 86_400_000).toISOString();
    baseSeed.item_state = [mkState('i2', { pinned: true, pinned_at: futureIso })];
    const fake = makeFakeSupabase(baseSeed);
    const realFrom = fake.client.from.bind(fake.client);
    let releaseResync: () => void = () => {};
    let resyncStartedResolve!: () => void;
    const resyncStarted = new Promise<void>((r) => (resyncStartedResolve = r));
    let reads = 0;
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      reads += 1;
      const settle = {
        data: (fake.store.item_state ?? []).map((r) => ({ ...r })),
        count: null,
        error: null,
      };
      if (reads === 2) {
        const held = new Promise<typeof settle>((res) => {
          releaseResync = () => res(settle);
        });
        resyncStartedResolve();
        return itemStateReadStub(() => held) as ReturnType<typeof realFrom>;
      }
      // reads >= 3 is the lwwLossPending re-pull — hold it open so it can't
      // correct the store, proving the read's own per-field LWW already adopts
      // the newer server value.
      if (reads >= 3) {
        return itemStateReadStub(() => new Promise(() => {})) as ReturnType<typeof realFrom>;
      }
      return itemStateReadStub(() => settle) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.getItemsByIds([]); // boot → store holds i2 pinned
    expect(ds.stateStore.get('i2').pinned).toBe(true);

    const resync = ds.resyncState();
    await resyncStarted; // resync read parked, holding the (pinned) snapshot

    // Unpin i2 during the read; the write loses LWW on the server (older `at`).
    ds.stateStore.set('i2', 'pinned', false);
    await drainOutbox(ds);
    expect((fake.store.item_state ?? []).find((r) => r.item_id === 'i2')?.pinned)
      .toBe(true); // server kept the newer pin — our unpin lost

    releaseResync();
    await resync;

    // The lost unpin must not be re-overlaid: the store reflects server truth.
    expect(ds.stateStore.get('i2').pinned).toBe(true);
  });

  it('keeps a field that WON LWW while a sibling field of the same write lost', async () => {
    // A pin touches multiple fields (pinned:true + done:false). If another device
    // set a NEWER done, per-field LWW splits: the local pin keeps pinned=true (its
    // clock beats the server), while the newer server done is adopted — exactly
    // the field-by-field resolution, no whole-row revert of the winning pin.
    const baseSeed = seed();
    // Another device marked i2 Done with a timestamp NEWER than our clock, so our
    // pin's done-clear loses LWW while the pin itself (no prior pinned_at) wins.
    const futureIso = new Date(Date.now() + 86_400_000).toISOString();
    baseSeed.item_state = [mkState('i2', { done: true, done_at: futureIso })];
    const fake = makeFakeSupabase(baseSeed);
    const realFrom = fake.client.from.bind(fake.client);
    let releaseResync: () => void = () => {};
    let resyncStartedResolve!: () => void;
    const resyncStarted = new Promise<void>((r) => (resyncStartedResolve = r));
    let reads = 0;
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      reads += 1;
      const settle = {
        data: (fake.store.item_state ?? []).map((r) => ({ ...r })),
        count: null,
        error: null,
      };
      if (reads === 2) {
        const held = new Promise<typeof settle>((res) => {
          releaseResync = () => res(settle);
        });
        resyncStartedResolve();
        return itemStateReadStub(() => held) as ReturnType<typeof realFrom>;
      }
      // reads >= 3 (the lwwLoss re-pull) — held open so it can't correct the
      // store, proving per-field LWW keeps the winning pin from the read alone.
      if (reads >= 3) {
        return itemStateReadStub(() => new Promise(() => {})) as ReturnType<typeof realFrom>;
      }
      return itemStateReadStub(() => settle) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.getItemsByIds([]); // boot → store holds i2 done (pinned false)
    expect(ds.stateStore.get('i2').pinned).toBe(false);

    const resync = ds.resyncState();
    await resyncStarted; // resync read parked, holding the pre-pin (Done) snapshot

    // Pin i2 during the read: pinned:true wins, the done:false clear loses LWW.
    ds.stateStore.set('i2', 'pinned', true);
    await drainOutbox(ds);
    const serverRow = (fake.store.item_state ?? []).find((r) => r.item_id === 'i2');
    expect(serverRow?.pinned).toBe(true); // pin committed
    expect(serverRow?.done).toBe(true); // done-clear lost to the newer Done

    releaseResync();
    await resync;

    // The winning pin must survive even though its sibling done lost LWW.
    expect(ds.stateStore.get('i2').pinned).toBe(true);
  });

  it('keeps a field re-changed by a later WINNING write after an earlier write LOST it', async () => {
    // A field can be written several times during one long parked read. If an
    // early write loses LWW but a later write to the SAME field wins (lose →
    // toggle → win), the store's latest `<f>At` (the winning write's) is what the
    // hydrate compares, so LWW keeps the winning value over the stale read. Uses
    // explicit action timestamps so the server's per-field LWW is deterministic.
    const baseSeed = seed();
    // Another device left i2 unpinned with last-change clock 2000: a write older
    // than 2000 loses, one at/after 2000 wins.
    baseSeed.item_state = [mkState('i2', { pinned: false, pinned_at: new Date(2000).toISOString() })];
    const fake = makeFakeSupabase(baseSeed);
    const realFrom = fake.client.from.bind(fake.client);
    let releaseResync: () => void = () => {};
    let resyncStartedResolve!: () => void;
    const resyncStarted = new Promise<void>((r) => (resyncStartedResolve = r));
    let reads = 0;
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      reads += 1;
      const settle = {
        data: (fake.store.item_state ?? []).map((r) => ({ ...r })),
        count: null,
        error: null,
      };
      if (reads === 2) {
        const held = new Promise<typeof settle>((res) => {
          releaseResync = () => res(settle);
        });
        resyncStartedResolve();
        return itemStateReadStub(() => held) as ReturnType<typeof realFrom>;
      }
      // reads >= 3 (the lwwLoss re-pull from the early loss) — held open so it
      // can't correct the store, proving the store's latest clock drives the read.
      if (reads >= 3) {
        return itemStateReadStub(() => new Promise(() => {})) as ReturnType<typeof realFrom>;
      }
      return itemStateReadStub(() => settle) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.getItemsByIds([]); // boot → store holds i2 unpinned
    expect(ds.stateStore.get('i2').pinned).toBe(false);

    const resync = ds.resyncState();
    await resyncStarted; // read parked, holding the unpinned snapshot

    // Pin@1000 LOSES (older than the server's 2000 clock). Drain so it actually
    // sends and is recorded as lost (not coalesced away by the later writes).
    ds.stateStore.set('i2', 'pinned', true, 1000);
    await drainOutbox(ds);
    expect((fake.store.item_state ?? []).find((r) => r.item_id === 'i2')?.pinned).toBe(false);
    // Toggle: unpin@2500 then pin@3000, both NEWER than 2000 so they WIN.
    ds.stateStore.set('i2', 'pinned', false, 2500);
    await drainOutbox(ds);
    ds.stateStore.set('i2', 'pinned', true, 3000);
    await drainOutbox(ds);
    expect((fake.store.item_state ?? []).find((r) => r.item_id === 'i2')?.pinned).toBe(true);

    releaseResync();
    await resync;

    // The final winning pin must survive — not reverted to the unpinned snapshot
    // by the stale lost marker from the @1000 write.
    expect(ds.stateStore.get('i2').pinned).toBe(true);
  });

  it('overlays a during-read write that drained on a clock TIE with the parked server row', async () => {
    // A write made AND drained during the parked read whose `at` exactly ties the
    // parked server row's `<f>At` (same-ms toggle / reduced timer precision). The
    // server accepts the tie via `>=` and echoes our `at`, so the outbox drains
    // clean — no lost marker, no lwwLossPending re-pull. But the parked snapshot
    // still carries the PRE-write value at that same clock, and the store's
    // hydrate compares with strict `>`, so per-field LWW alone would adopt the
    // stale server value and silently revert the write. The during-read note must
    // carry the changed FIELDS (not just the id) so the overlay keeps it.
    const baseSeed = seed();
    // Server holds i2 unpinned with last-change clock 5000; our pin@5000 ties it.
    baseSeed.item_state = [mkState('i2', { pinned: false, pinned_at: new Date(5000).toISOString() })];
    const fake = makeFakeSupabase(baseSeed);
    const realFrom = fake.client.from.bind(fake.client);
    let releaseResync: () => void = () => {};
    let resyncStartedResolve!: () => void;
    const resyncStarted = new Promise<void>((r) => (resyncStartedResolve = r));
    let reads = 0;
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      reads += 1;
      const settle = {
        data: (fake.store.item_state ?? []).map((r) => ({ ...r })),
        count: null,
        error: null,
      };
      if (reads === 2) {
        const held = new Promise<typeof settle>((res) => {
          releaseResync = () => res(settle);
        });
        resyncStartedResolve();
        return itemStateReadStub(() => held) as ReturnType<typeof realFrom>;
      }
      // No re-pull is expected (the tie drains clean) — hold any later read open
      // so the test proves the parked read's own reconcile keeps the write.
      if (reads >= 3) {
        return itemStateReadStub(() => new Promise(() => {})) as ReturnType<typeof realFrom>;
      }
      return itemStateReadStub(() => settle) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.getItemsByIds([]); // boot → store holds i2 unpinned@5000
    expect(ds.stateStore.get('i2').pinned).toBe(false);

    const resync = ds.resyncState();
    await resyncStarted; // resync read parked, holding the unpinned@5000 snapshot

    // Pin i2 at the SAME clock the parked row carries; it drains and WINS the tie
    // on the server (no loss, no re-pull), so only the overlay can preserve it.
    ds.stateStore.set('i2', 'pinned', true, 5000);
    await drainOutbox(ds);
    const serverRow = (fake.store.item_state ?? []).find((r) => r.item_id === 'i2');
    expect(serverRow?.pinned).toBe(true); // tie accepted via `>=`
    expect(ds.pendingItemIds().has('i2')).toBe(false); // outbox already empty

    releaseResync();
    await resync;

    // The pin survives the tied parked snapshot — overlaid, not reverted to false.
    expect(ds.stateStore.get('i2').pinned).toBe(true);
  });

  it('resyncState keeps the last good hydration when the re-pull fails', async () => {
    // After a successful boot hydration, a focus/visibility resync that fails
    // (offline / transient / cache miss) must NOT null the memo — otherwise the
    // next feed/library read re-fetches item_state and fails on it instead of
    // using last-good state.
    await env.ds.getItemsByIds([]); // boot hydration succeeds; i2 pinned
    expect(Object.fromEntries(env.ds.stateStore.entries())['i2']?.pinned).toBe(true);

    // From now on every item_state read errors (e.g. the device went offline).
    const realFrom = env.fake.client.from.bind(env.fake.client);
    env.fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      return itemStateReadStub(() => ({
        data: null,
        count: null,
        error: { message: 'offline' },
      })) as ReturnType<typeof realFrom>;
    }) as never) as typeof env.fake.client.from;

    // The resync attempt fails and is swallowed (as the hook does).
    await env.ds.resyncState().catch(() => {});
    // Last-good state is intact...
    expect(Object.fromEntries(env.ds.stateStore.entries())['i2']?.pinned).toBe(true);
    // ...and a feed read still resolves: ensureHydrated returns the preserved
    // memo instead of re-reading the now-failing item_state.
    const page = await env.ds.getHomeItems();
    expect(ids(page.items)).toContain('i2');
  });

  it('rolls back an optimistic row when a permanent reject reconcile omits it', async () => {
    // A write that permanently rejects (lost visibility / cascade-delete) clears
    // the hydration memo and re-pulls to roll back the optimistic state. The
    // authoritative reconcile must DROP the now-omitted, no-longer-pending row.
    const env = setup();
    await env.ds.getItemsByIds([]); // boot: i2 pinned, version confirmed
    expect(env.ds.stateStore.get('i2').pinned).toBe(true);

    // The set_item_state write is permanently rejected (42501 lost visibility),
    // and i2 is no longer returned by item_state reads (it's gone server-side).
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'set_item_state') {
        return Promise.resolve({
          data: null,
          error: { code: '42501', message: 'lost visibility' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    const realFrom = env.fake.client.from.bind(env.fake.client);
    env.fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      return itemStateReadStub(() => ({ data: [], count: null, error: null })) as ReturnType<
        typeof realFrom
      >;
    }) as never) as typeof env.fake.client.from;

    // A write on i2 → permanent reject → onPermanentReject → reconcile re-pull.
    // Resolve when the store emits the rolled-back (no-longer-pinned) i2, so the
    // assertion waits on the actual reconcile, not a timer.
    const rolledBack = new Promise<void>((resolve) => {
      const unsub = env.ds.stateStore.subscribe(() => {
        if (!env.ds.stateStore.get('i2').pinned) {
          unsub();
          resolve();
        }
      });
    });
    env.ds.stateStore.set('i2', 'opened', true);
    await rolledBack;

    expect(env.ds.stateStore.get('i2').pinned).toBe(false); // rolled back
  });

  it('does not leak an unhandled rejection when the correction re-pull after a permanent reject fails', async () => {
    // Regression: onPermanentReject kicked `void this.ensureHydrated()` with no
    // catch; ensureHydrated re-throws after clearing the memo, so a correction
    // re-pull that fails (e.g. the device went offline right as the write was
    // rejected) surfaced as an unhandled rejection. The memo is still cleared,
    // so the next read retries — the rejection just must not escape.
    const env = setup();
    await env.ds.getItemsByIds([]); // boot hydration succeeds

    // The set_item_state write is permanently rejected (42501 lost visibility)…
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'set_item_state') {
        return Promise.resolve({
          data: null,
          error: { code: '42501', message: 'lost visibility' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;

    // …and every subsequent item_state read fails, so the re-pull rejects.
    let repullStarted!: () => void;
    const repullRan = new Promise<void>((r) => (repullStarted = r));
    const realFrom = env.fake.client.from.bind(env.fake.client);
    env.fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      repullStarted();
      return itemStateReadStub(() => Promise.reject(new Error('offline'))) as ReturnType<
        typeof realFrom
      >;
    }) as never) as typeof env.fake.client.from;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      env.ds.stateStore.set('i2', 'opened', true); // → permanent reject → re-pull
      await repullRan;
      // Let the rejection propagate: its handlers (or their absence) resolve in
      // microtasks, and node emits unhandledRejection only after the microtask
      // queue drains — so yield a full turn, twice, before asserting.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not strand the feed on its skeletons when item_state hydration hangs but state is already loaded', async () => {
    // Repro of the "all cards stuck loading" bug. A feed read used to AWAIT the
    // full (paged, serialized) item_state hydration before returning any row, so
    // a slow/large or stalled item_state read held the home feed query in its
    // initial loading state — and because every cold boot re-runs the same
    // blocking read, the stuck skeletons survived reload and pull-to-refresh.
    // item_state hydration is best-effort (feed_items filters Done/Hidden
    // server-side; the local store carries last-good flags), so once there's
    // state to overlay a read must NOT block on it.
    const env = setup();
    await env.ds.getItemsByIds([]); // boot hydration succeeds → store warm (i2 pinned)
    expect(env.ds.stateStore.get('i2').pinned).toBe(true);

    // From now on every item_state read HANGS — a connection that's established
    // but never answers (a stalled backend, or a service-worker NetworkOnly read
    // that never settles), the case the 8s fetch cap can't always rescue.
    let hungReadStarted!: () => void;
    const hungRead = new Promise<void>((r) => (hungReadStarted = r));
    const realFrom = env.fake.client.from.bind(env.fake.client);
    env.fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      hungReadStarted();
      return itemStateReadStub(() => new Promise(() => {})) as ReturnType<typeof realFrom>;
    }) as never) as typeof env.fake.client.from;

    // Null the hydration memo so the next read would otherwise re-pull (and hang
    // on) item_state: a permanent write rejection clears the memo and kicks a
    // reconcile re-pull, which is now the hung read above.
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'set_item_state') {
        return Promise.resolve({
          data: null,
          error: { code: '42501', message: 'lost visibility' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    env.ds.stateStore.set('i2', 'opened', true); // → permanent reject → memo null → hung re-pull
    await hungRead; // the reconcile re-pull has fired and is now hanging

    // The feed read must still resolve (overlaying the warm store), not hang on
    // the in-flight item_state read. Before the fix this awaited the hung memo
    // and never settled — the test would time out.
    const page = await env.ds.getHomeItems();
    expect(page.items.length).toBeGreaterThan(0);
    expect(env.ds.stateStore.get('i2').pinned).toBe(true); // last-good state preserved
  });

  it('sends a brand-new-row write immediately even while the boot item_state hydrate is in flight', async () => {
    // Per-field last-write-wins needs no concurrency base, so a write made before
    // the boot read lands is NOT held — it flushes right away carrying its action
    // timestamp, and the server resolves any cross-device race by `at`. (This is
    // the deliberate simplification over the old hold-for-hydration machinery.)
    const fake = makeFakeSupabase(seed());
    const realFrom = fake.client.from.bind(fake.client);
    let bootStartedResolve!: () => void;
    const bootStarted = new Promise<void>((r) => (bootStartedResolve = r));
    let reads = 0;
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      reads += 1;
      if (reads === 1) {
        // Boot read: parked open so the hydrate stays in flight.
        const held = new Promise(() => {});
        bootStartedResolve();
        return itemStateReadStub(() => held) as ReturnType<typeof realFrom>;
      }
      return itemStateReadStub(() => ({
        data: (fake.store.item_state ?? []).map((r) => ({ ...r })),
        count: null,
        error: null,
      })) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    let setCalls = 0;
    let lastParams: Record<string, unknown> | undefined;
    const realRpc = fake.client.rpc.bind(fake.client);
    fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'set_item_state') {
        setCalls += 1;
        lastParams = params;
      }
      return realRpc(name, params);
    }) as typeof fake.client.rpc;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await bootStarted; // boot read parked → a hydrate is in flight

    // i6 has no item_state row in the seed — a brand-new row. Pinning it flushes
    // straight away, no hold.
    ds.stateStore.set('i6', 'pinned', true);
    await new Promise((r) => setTimeout(r));
    expect(setCalls).toBe(1);
    expect(lastParams?.p_pinned).toBe(true);
    expect(typeof lastParams?.p_pinned_at).toBe('string'); // carries its LWW clock
    expect(ds.stateStore.get('i6').pinned).toBe(true); // optimistic UI applied
  });

  it('does not block a cold (empty-store) feed read indefinitely when the item_state hydrate stalls', async () => {
    // On a fresh / cache-purged device the store is empty, so a feed read waits
    // for the first hydration — but that wait is BOUNDED, so a slow/stalled cold
    // read can't strand a first-time user on skeletons (the bug, but cold-cache).
    vi.useFakeTimers();
    try {
      const fake = makeFakeSupabase(seed());
      const realFrom = fake.client.from.bind(fake.client);
      fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
        if (table !== 'item_state') return realFrom(table);
        // Hung item_state read: hydration never settles.
        return itemStateReadStub(() => new Promise(() => {})) as ReturnType<typeof realFrom>;
      }) as never) as typeof fake.client.from;

      const ds = new SupabaseDataSource(
        'readmo:item-state:test',
        fake.client as unknown as SupabaseClient,
      );
      // Empty store + a hydrate that never settles. The read must still resolve
      // once the cold-wait bound elapses, serving the server-filtered feed.
      const pagePromise = ds.getHomeItems();
      await vi.advanceTimersByTimeAsync(4000); // past COLD_HYDRATE_WAIT_MS
      const page = await pagePromise;
      expect(page.items.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resyncState coalesces concurrent calls into a single re-pull', async () => {
    await env.ds.getItemsByIds([]); // settle the eager boot hydration
    const before = env.fake.selectCount('item_state');
    // A single tab return can fire focus AND visibilitychange; both must resolve
    // to one item_state read, not two.
    await Promise.all([env.ds.resyncState(), env.ds.resyncState()]);
    expect(env.fake.selectCount('item_state')).toBe(before + 1);
  });

  it('runs a fresh resync if one was requested while a failing one was in flight', async () => {
    // A resync started during a connectivity blip is doomed; an `online` event
    // that arrives before it settles coalesces into it. When that attempt fails,
    // a fresh live read must run so the recovery isn't lost.
    const env = setup();
    await env.ds.getItemsByIds([]); // boot hydration (real fake)

    let resyncReads = 0;
    let failFirst: () => void = () => {};
    let retryStarted: () => void = () => {};
    const retried = new Promise<void>((res) => {
      retryStarted = res;
    });
    // Signals when read #1 has actually fired (hydrations are serialized, so the
    // read starts a microtask after resyncState() returns — wait for it before
    // failing it, rather than assuming it ran synchronously).
    let firstReadStartedResolve!: () => void;
    const firstReadStarted = new Promise<void>((r) => (firstReadStartedResolve = r));
    const realFrom = env.fake.client.from.bind(env.fake.client);
    env.fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      resyncReads++;
      if (resyncReads === 1) {
        // The in-flight (doomed) resync read: held open, then rejects.
        const p = new Promise((_res, rej) => {
          failFirst = () => rej(new Error('blip'));
        });
        firstReadStartedResolve();
        return itemStateReadStub(() => p) as ReturnType<typeof realFrom>;
      }
      // The retry read: signal that a fresh resync ran, then succeed.
      retryStarted();
      return itemStateReadStub(() => ({ data: [], count: null, error: null })) as ReturnType<
        typeof realFrom
      >;
    }) as never) as typeof env.fake.client.from;

    const a = env.ds.resyncState().catch(() => {}); // in flight (read #1)
    const b = env.ds.resyncState().catch(() => {}); // coalesces → sets pending
    await firstReadStarted; // read #1 has fired and failFirst is wired
    failFirst(); // read #1 rejects
    await Promise.all([a, b]);
    await retried; // a fresh resync (read #2) ran after the failure
    expect(resyncReads).toBe(2);
  });

  it('resyncState(force) chains a fresh read past an in-flight one', async () => {
    // The reverse newshacker pull applies changes server-side then resyncs, but a
    // focus resync (useStateSync) can already be in flight, reading item_state
    // BEFORE the pull's write. A plain coalesced call would clear without
    // re-reading; force must run a guaranteed-fresh read so the write is seen.
    const env = setup();
    await env.ds.getItemsByIds([]); // boot hydrate (real fake)

    let reads = 0;
    let releaseFirst!: () => void;
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((r) => (firstStartedResolve = r));
    const realFrom = env.fake.client.from.bind(env.fake.client);
    env.fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      reads++;
      if (reads === 1) {
        const p = new Promise((res) => {
          releaseFirst = () => res({ data: [], count: null, error: null });
        });
        firstStartedResolve();
        return itemStateReadStub(() => p) as ReturnType<typeof realFrom>;
      }
      return itemStateReadStub(() => ({ data: [], count: null, error: null })) as ReturnType<
        typeof realFrom
      >;
    }) as never) as typeof env.fake.client.from;

    const a = env.ds.resyncState(); // read #1 (held open)
    await firstStarted;
    const b = env.ds.resyncState(true); // force → must NOT coalesce onto read #1
    releaseFirst(); // read #1 completes
    await Promise.all([a, b]);
    // force forced a second, fresh read after the in-flight one.
    expect(reads).toBe(2);
  });

  it('an offline item_state read keeps the persisted store, not drops it', async () => {
    // item_state is read NetworkOnly (no cache fallback), so offline the read
    // fails rather than serving a stale cached snapshot. The store must keep its
    // last-good localStorage state (e.g. a pin synced from another device last
    // session) — never reconcile it away against a read that couldn't run.
    const fake = makeFakeSupabase(seed());
    fake.store.item_state.push(mkState('i6', { pinned: true, pinned_at: recent }));
    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.getItemsByIds([]); // boot hydrate (real fake): i6 pinned, non-pending
    expect(ds.stateStore.get('i6').pinned).toBe(true);

    // Device goes offline: every item_state read now fails.
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      return itemStateReadStub(() => ({
        data: null,
        count: null,
        error: { message: 'offline' },
      })) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    // A failed resync leaves the store untouched...
    await ds.resyncState().catch(() => {});
    expect(ds.stateStore.get('i6').pinned).toBe(true);
    // ...and an offline library read falls back to the store (best-effort), so
    // the synced pin survives rather than being dropped.
    await ds.getItemsByIds([]);
    expect(ds.stateStore.get('i6').pinned).toBe(true);
  });

  it('resyncState preserves an un-synced local pin while adopting server truth', async () => {
    await env.ds.getItemsByIds([]); // settle the eager boot hydration
    // Pin i3 locally (optimistic + queued in the outbox).
    env.ds.stateStore.set('i3', 'pinned', true);
    // Another device favorites i6 directly on the server.
    env.fake.store.item_state.push(mkState('i6', { favorite: true, favorite_at: recent }));

    await env.ds.resyncState();

    const entries = Object.fromEntries(env.ds.stateStore.entries());
    // The local pin survives the re-pull (preserved by the pending overlay, or
    // already flushed to the server — either way it must not be wiped)...
    expect(entries['i3']?.pinned).toBe(true);
    // ...and the other device's favorite is adopted.
    expect(entries['i6']?.favorite).toBe(true);
  });

  it('reads ALL item_state in pages so a >1000-row account does not lose swept/pinned state', async () => {
    // PostgREST caps a single response at 1000 rows. An active account writes one
    // item_state row per pin/favorite/done/open and they are never auto-deleted,
    // so the set outgrows the cap. An unpaged hydrate read would then be silently
    // truncated, and `hydrate` would treat every row past the cap as genuinely
    // absent (stale) and DROP its local flag — resurfacing swept items and
    // dropping pins. The read must page past the cap so its view is complete.
    const tables = seed();
    // Build a large item_state set: a swept (done) row and a pinned row that BOTH
    // sort after the 1000-row cap by item_id, so an unpaged read can't see them.
    const sweptId = 'zzz-swept'; // sorts last by item_id → past the cap
    const pinnedId = 'zzz-pinned';
    tables.items = [
      ...tables.items,
      mkItem(sweptId, 'feed-a', 6, 'Swept past the cap'),
      mkItem(pinnedId, 'feed-a', 6, 'Pinned past the cap'),
    ];
    tables.item_state = [
      // 1000 filler rows (id000…id999) that occupy the whole first response page.
      ...Array.from({ length: 1000 }, (_v, i) =>
        mkState(`id${String(i).padStart(3, '0')}`, { opened: true, opened_at: recent }),
      ),
      mkState(sweptId, { done: true, done_at: recent }),
      mkState(pinnedId, { pinned: true, pinned_at: recent }),
    ];
    const fake = makeFakeSupabase(tables);
    fake.capRows('item_state', 1000); // model PostgREST's max-rows ceiling
    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );

    await ds.resyncState(); // full re-pull (paged)

    // The swept item keeps its Done flag and the pin survives — both live past the
    // first 1000-row page and would be wiped by a single truncated read.
    expect(ds.stateStore.get(sweptId).done).toBe(true);
    expect(ds.stateStore.get(pinnedId).pinned).toBe(true);
    // And a normal in-cap row is still hydrated.
    expect(ds.stateStore.get('id000').opened).toBe(true);
  });

  it('tags each item_state read with a unique cache-buster (live-or-fail under any service worker)', async () => {
    // The read appends an always-unique `item_id=not.eq.<uuid>` filter so the URL
    // differs per read. That busts any URL-keyed cache — including a *previous*
    // service worker's NetworkFirst `/rest/v1/` route during a rollout — so a
    // stale cached 200 can never be served as authoritative. The filter excludes
    // nothing (no row has that id), so hydration still adopts every row.
    const fake = makeFakeSupabase(seed());
    const tokens: string[] = [];
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      const q = realFrom(table) as ReturnType<typeof realFrom> & {
        not: (col: string, op: string, value: string) => unknown;
      };
      if (table === 'item_state') {
        const realNot = q.not.bind(q);
        q.not = (col: string, op: string, value: string) => {
          if (col === 'item_id' && op === 'eq') tokens.push(value);
          return realNot(col, op, value);
        };
      }
      return q;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.getItemsByIds([]); // eager boot read → token #1
    expect(Object.fromEntries(ds.stateStore.entries())['i2']?.pinned).toBe(true); // rows still adopted
    await ds.resyncState(); // resync read → token #2

    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tokens).size).toBe(tokens.length); // every read's token is distinct
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
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

  it('getFeed applies subscription title_override over the raw feed title', async () => {
    env.fake.store.subscriptions.find((s) => s.feed_id === 'feed-a')!.title_override = 'My Custom Name';
    const feed = await env.ds.getFeed('feed-a');
    expect(feed?.title).toBe('My Custom Name');
  });

  it('getFeed falls back to the raw feed title when title_override is null', async () => {
    const feed = await env.ds.getFeed('feed-a');
    expect(feed?.title).toBe('Alpha Blog');
  });

  it('getFeed applies title_override even when the feed is cached', async () => {
    // Warm the feedCache via a prior call.
    await env.ds.getFeed('feed-a');
    env.fake.store.subscriptions.find((s) => s.feed_id === 'feed-a')!.title_override = 'Cached Override';
    const feed = await env.ds.getFeed('feed-a');
    expect(feed?.title).toBe('Cached Override');
  });

  it('getFeedItems applies title_override in FeedItem.feed so item-row labels show the display name', async () => {
    env.fake.store.subscriptions.find((s) => s.feed_id === 'feed-a')!.title_override = 'Alpha Renamed';
    const page = await env.ds.getFeedItems('feed-a');
    expect(page.items.length).toBeGreaterThan(0);
    for (const fi of page.items) {
      expect(fi.feed.title).toBe('Alpha Renamed');
    }
  });

  it('fails the read when the override lookup errors, so a retry restores renames', async () => {
    // Regression: the override read's error was swallowed (`result.data ?? []`),
    // so a transient failure (401 mid-token-refresh, 5xx blip) cached the raw
    // feed titles for the whole session — feedCache never refetches an id it
    // already holds, so every rename silently disappeared until a reload.
    env.fake.store.subscriptions.find((s) => s.feed_id === 'feed-a')!.title_override =
      'Alpha Renamed';
    env.fake.failSelectOnce('subscriptions');
    await expect(env.ds.getFeedItems('feed-a')).rejects.toThrow(/title overrides/);
    // The failure cached nothing: the retry re-reads and applies the rename.
    const page = await env.ds.getFeedItems('feed-a');
    expect(page.items.length).toBeGreaterThan(0);
    for (const fi of page.items) {
      expect(fi.feed.title).toBe('Alpha Renamed');
    }
  });

  it('getHomeItems applies title_override in FeedItem.feed', async () => {
    env.fake.store.subscriptions.find((s) => s.feed_id === 'feed-b')!.title_override = 'Beta Renamed';
    const page = await env.ds.getHomeItems();
    const betaItems = page.items.filter((fi) => fi.feed.id === 'feed-b');
    expect(betaItems.length).toBeGreaterThan(0);
    for (const fi of betaItems) {
      expect(fi.feed.title).toBe('Beta Renamed');
    }
  });

  it('setTitleOverride evicts feedCache so the next getFeedItems sees the new override', async () => {
    // Warm the cache for feed-a first (simulates subscribe()'s getFeed() call).
    await env.ds.getFeed('feed-a');
    // Now set a title override — this should evict the cached (raw-title) entry.
    env.fake.store.subscriptions.find((s) => s.feed_id === 'feed-a')!.title_override = 'Post-Subscribe Override';
    await env.ds.setTitleOverride('feed-a', 'Post-Subscribe Override');
    // getFeedItems must re-fetch and apply the override despite the prior cache hit.
    const page = await env.ds.getFeedItems('feed-a');
    expect(page.items.length).toBeGreaterThan(0);
    for (const fi of page.items) {
      expect(fi.feed.title).toBe('Post-Subscribe Override');
    }
  });
});

describe('SupabaseDataSource dispatch + writes', () => {
  it('writes item-state mutations through the set_item_state RPC (changed fields only)', async () => {
    const env = setup();
    await env.ds.getHomeItems(); // hydrate

    // Hiding i6 writes the changed field through to the server (plus its
    // exclusivity closure — a dismiss clears pinned), each carrying the action
    // time as its per-field last-write-wins clock.
    env.ds.stateStore.set('i6', 'hidden', true);
    await new Promise((r) => setTimeout(r)); // drain the per-item write chain
    const write = env.fake.rpcCalls.find(
      (c) => c.name === 'set_item_state' && c.params.p_item_id === 'i6',
    );
    expect(write?.params.p_hidden).toBe(true);
    expect(typeof write?.params.p_hidden_at).toBe('string');
    expect(Number.isNaN(Date.parse(write?.params.p_hidden_at as string))).toBe(false);
    // No version/base param survives in the LWW write path.
    expect(write?.params).not.toHaveProperty('p_base_version');

    // ...so the next feed read (server truth via feed_items) no longer surfaces it.
    const page = await env.ds.getHomeItems();
    expect(ids(page.items)).not.toContain('i6');
  });

  it('re-pulls server truth when an LWW write loses, correcting the stale optimistic value', async () => {
    // i2 is pinned server-side at `recent`. A *stale* local unpin —
    // an older action than the server's pin — loses LWW: the RPC returns the
    // unchanged (still-pinned) row with no error. Without correction the device
    // would keep showing its losing unpinned state until an unrelated resync; the
    // send path must detect the loss from the returned row and re-hydrate at once.
    const env = setup();
    await env.ds.getHomeItems(); // boot hydrate → store shows i2 pinned
    expect(env.ds.stateStore.get('i2').pinned).toBe(true);

    // The optimistic unpin fires (pinned=false), then the re-pull restores true.
    const corrected = new Promise<void>((resolve) => {
      const unsub = env.ds.stateStore.subscribe(() => {
        if (env.ds.stateStore.get('i2').pinned) {
          unsub();
          resolve();
        }
      });
    });
    const staleAt = Date.parse(recent) - 24 * 60 * 60 * 1000; // older than `recent`
    env.ds.stateStore.set('i2', 'pinned', false, staleAt);
    expect(env.ds.stateStore.get('i2').pinned).toBe(false); // optimistic loser shown

    await corrected;
    expect(env.ds.stateStore.get('i2').pinned).toBe(true); // server truth restored
  });

  it('re-pulls when an LWW write loses only on the clock (boolean already matched)', async () => {
    // Offline-replay race: this device marked i6 done "yesterday" (T1) while
    // another device already set done "today" (recent, T2 > T1). The boolean
    // matches (both done=true), but our older write loses on the LWW clock, so the
    // server keeps done_at=T2. A boolean-only loss check would skip the re-pull and
    // leave the local store with the stale T1 doneAt — skewing the 30-day TTL and
    // /done ordering. The returned-row timestamp comparison must catch it.
    const fake = makeFakeSupabase(seed());
    fake.store.item_state.push(mkState('i6', { done: true, done_at: recent })); // server "today"
    // Boot reads fail (so the store doesn't hydrate i6 first); the re-pull's read
    // then succeeds and corrects the timestamp.
    const realFrom = fake.client.from.bind(fake.client);
    let readsWork = false;
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      if (table !== 'item_state' || readsWork) return realFrom(table);
      return itemStateReadStub(() => ({
        data: null,
        count: null,
        error: { message: 'offline' },
      })) as ReturnType<typeof realFrom>;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.getItemsByIds([]).catch(() => {}); // boot hydrate fails → i6 absent locally
    expect(ds.stateStore.get('i6').doneAt).toBeNull();

    readsWork = true; // the loss-triggered re-pull will now succeed
    const t2 = Date.parse(recent);
    const t1 = t2 - 10 * 24 * 60 * 60 * 1000; // older than recent
    const corrected = new Promise<void>((resolve) => {
      const unsub = ds.stateStore.subscribe(() => {
        if (ds.stateStore.get('i6').doneAt === t2) {
          unsub();
          resolve();
        }
      });
    });
    ds.stateStore.set('i6', 'done', true, t1); // optimistic done=true@T1, queued + flushed
    expect(ds.stateStore.get('i6').doneAt).toBe(t1); // stale local timestamp shown

    await corrected;
    expect(ds.stateStore.get('i6').done).toBe(true);
    expect(ds.stateStore.get('i6').doneAt).toBe(t2); // adopted the server's newer doneAt
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

  it('discover maps a `blocked` function error to AddFeedError("blocked")', async () => {
    const env = setup();
    const res = new Response(
      JSON.stringify({ error: "Google News feeds aren't available on this account.", code: 'blocked' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    );
    env.fake.invokeResult.current = { data: null, error: new FunctionsHttpError(res) };
    await expect(
      env.ds.discover('https://news.google.com/rss/search?q=site:example.com'),
    ).rejects.toMatchObject({ name: 'AddFeedError', kind: 'blocked' });
  });

  it('pullNewshackerState invokes the GET branch and re-hydrates when dones applied', async () => {
    const env = setup();
    env.fake.invokeResult.current = { data: { linked: true, applied: 2 }, error: null };
    const resync = vi.spyOn(env.ds, 'resyncState').mockResolvedValue();
    const res = await env.ds.pullNewshackerState();
    expect(res).toEqual({ linked: true, applied: 2 });
    expect(env.fake.invokeCalls).toContainEqual({
      name: 'newshacker-sync',
      body: undefined,
      method: 'GET',
    });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('pullNewshackerState does not re-hydrate when nothing was applied', async () => {
    const env = setup();
    env.fake.invokeResult.current = { data: { linked: true, applied: 0 }, error: null };
    const resync = vi.spyOn(env.ds, 'resyncState').mockResolvedValue();
    const res = await env.ds.pullNewshackerState();
    expect(res).toEqual({ linked: true, applied: 0 });
    expect(resync).not.toHaveBeenCalled();
  });

  it('pullNewshackerState reports unlinked + not-ok on a function error and skips re-hydrate', async () => {
    const env = setup();
    env.fake.invokeResult.current = { data: null, error: { message: 'boom' } };
    const resync = vi.spyOn(env.ds, 'resyncState').mockResolvedValue();
    const res = await env.ds.pullNewshackerState();
    expect(res).toEqual({ linked: false, applied: 0, ok: false });
    expect(resync).not.toHaveBeenCalled();
  });

  it('pullNewshackerState passes the Edge ok flag through verbatim', async () => {
    const env = setup();
    // Backend reached, newshacker not: the Edge soft-fails to 200 with ok:false.
    env.fake.invokeResult.current = {
      data: { linked: true, applied: 0, ok: false },
      error: null,
    };
    const res = await env.ds.pullNewshackerState();
    expect(res).toEqual({ linked: true, applied: 0, ok: false });
  });

  it('pullNewshackerState leaves ok undefined when an older backend omits it', async () => {
    const env = setup();
    env.fake.invokeResult.current = { data: { linked: true, applied: 0 }, error: null };
    const res = await env.ds.pullNewshackerState();
    expect(res.ok).toBeUndefined();
  });

  it('getCapabilities rethrows an error instead of caching all-false', async () => {
    // An error must NOT be swallowed into a permissive all-false: that would pin
    // "gate open" for the 5-min staleTime and let an off-list user issue fulltext
    // calls. Rethrow so React Query retries and keeps the prior value.
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_capabilities') {
        return Promise.resolve({
          data: null,
          error: { code: '503', message: 'service unavailable' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    await expect(env.ds.getCapabilities()).rejects.toThrow('service unavailable');
  });

  it('getCapabilities maps can_manage_users, defaulting a missing flag to false', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_capabilities') {
        return Promise.resolve({
          data: [{ family: false, admin: true, allowlist_armed: false, can_manage_users: true }],
          error: null,
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.getCapabilities()).toMatchObject({ admin: true, canManageUsers: true });

    // A row that omits the flag → false, so /admin hides the block/delete/sign-up
    // controls rather than rendering a bogus permissive state.
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_capabilities') {
        return Promise.resolve({
          data: [{ family: false, admin: true, allowlist_armed: false }],
          error: null,
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.getCapabilities()).toMatchObject({ admin: true, canManageUsers: false });
  });

  it('listAiCalls maps rows and coerces a bigint count for getAiCallCounts', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_ai_call_log') {
        return Promise.resolve({
          data: [
            {
              id: 2,
              kind: 'spoiler',
              status: 'failed',
              http_status: 503,
              item_id: 'item-9',
              item_title: 'Some match',
              error: 'Gemini HTTP 503',
              created_at: '2026-07-16T02:00:00.000Z',
            },
          ],
          error: null,
        });
      }
      if (name === 'admin_ai_call_counts') {
        // PostgREST serializes a bigint count as a string.
        return Promise.resolve({
          data: [{ kind: 'summary', status: 'ok', count: '12' }],
          error: null,
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;

    const calls = await env.ds.listAiCalls(50);
    expect(calls).toEqual([
      {
        kind: 'spoiler',
        status: 'failed',
        httpStatus: 503,
        itemId: 'item-9',
        itemTitle: 'Some match',
        error: 'Gemini HTTP 503',
        createdAt: '2026-07-16T02:00:00.000Z',
      },
    ]);
    const counts = await env.ds.getAiCallCounts(24);
    expect(counts).toEqual([{ kind: 'summary', status: 'ok', count: 12 }]);
  });

  it('listAiCalls / getAiCallCounts return [] against a backend without the RPC (PGRST202)', async () => {
    // Guardrail #11: a new client must tolerate the un-migrated backend — the
    // /admin/ai console then shows its empty state instead of crashing.
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_ai_call_log' || name === 'admin_ai_call_counts') {
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST202', message: 'function not found' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.listAiCalls()).toEqual([]);
    expect(await env.ds.getAiCallCounts()).toEqual([]);
  });

  it('listAiCalls rethrows a non-PGRST202 error (e.g. the non-admin 42501)', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_ai_call_log') {
        return Promise.resolve({
          data: null,
          error: { code: '42501', message: 'admin required' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    await expect(env.ds.listAiCalls()).rejects.toThrow('admin required');
  });

  it('listUsers maps rows, defaulting a missing blocked flag to false', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'list_users') {
        return Promise.resolve({
          data: [
            {
              email: 'a@example.com',
              created_at: '2024-01-01T00:00:00Z',
              last_sign_in_at: '2024-06-01T00:00:00Z',
              family: true,
              admin: false,
              blocked: true,
            },
            {
              // No `blocked` field on this row → maps to false.
              email: 'b@example.com',
              created_at: '2024-02-01T00:00:00Z',
              last_sign_in_at: null,
              family: false,
              admin: true,
            },
          ],
          error: null,
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.listUsers()).toEqual([
      {
        email: 'a@example.com',
        createdAt: '2024-01-01T00:00:00Z',
        lastSignInAt: '2024-06-01T00:00:00Z',
        family: true,
        admin: false,
        blocked: true,
      },
      {
        email: 'b@example.com',
        createdAt: '2024-02-01T00:00:00Z',
        lastSignInAt: null,
        family: false,
        admin: true,
        blocked: false,
      },
    ]);
  });

  it('listFeedStatuses maps rows', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_list_feeds') {
        return Promise.resolve({
          data: [
            {
              id: 'feed-1',
              title: 'A Feed',
              site_url: 'https://a.example',
              favicon_url: null,
              last_fetched_at: '2024-06-01T00:00:00Z',
              error_count: 9,
              last_error: 'boom',
              paused: true,
              subscriber_count: 4,
              sample_item_id: 'item-1',
              sample_item_title: 'An article',
              sample_has_full_content: false,
              sample_download_status: 'auth',
              sample_download_http: 403,
              sample_download_error: null,
              sample_download_robots_rule: null,
              sample_download_at: '2024-06-02T00:00:00Z',
            },
            {
              // No pinned sample, no recorded status, clean poll.
              id: 'feed-2',
              title: 'Quiet Feed',
              site_url: null,
              favicon_url: null,
              last_fetched_at: null,
              error_count: 0,
              last_error: null,
              paused: false,
              subscriber_count: 0,
              sample_item_id: null,
              sample_item_title: null,
              sample_has_full_content: null,
              sample_download_status: null,
              sample_download_http: null,
              sample_download_error: null,
              sample_download_robots_rule: null,
              sample_download_at: null,
            },
          ],
          error: null,
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;

    expect(await env.ds.listFeedStatuses()).toEqual([
      {
        id: 'feed-1',
        title: 'A Feed',
        siteUrl: 'https://a.example',
        faviconUrl: null,
        lastFetchedAt: '2024-06-01T00:00:00Z',
        errorCount: 9,
        lastError: 'boom',
        paused: true,
        subscriberCount: 4,
        fetchFailed: true,
        parked: true, // errorCount >= 8
        sample: {
          id: 'item-1',
          title: 'An article',
          hasFullContent: false,
          downloadStatus: 'auth',
          downloadHttpStatus: 403,
          downloadError: null,
          downloadRobotsRule: null,
          downloadAttemptedAt: '2024-06-02T00:00:00Z',
        },
      },
      {
        id: 'feed-2',
        title: 'Quiet Feed',
        siteUrl: null,
        faviconUrl: null,
        lastFetchedAt: null,
        errorCount: 0,
        lastError: null,
        paused: false,
        subscriberCount: 0,
        fetchFailed: false,
        parked: false,
        sample: null,
      },
    ]);
  });

  it('listFeedStatuses reports a malformed subscriber_count as unknown (null), not 0', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_list_feeds') {
        // A malformed row omitting subscriber_count / paused.
        return Promise.resolve({
          data: [{ id: 'feed-1', title: 'A Feed', error_count: 0 }],
          error: null,
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    const [feed] = await env.ds.listFeedStatuses();
    expect(feed.subscriberCount).toBeNull();
    // A malformed `paused` maps to null ("unknown"), not a false that would
    // render a bogus Pause control.
    expect(feed.paused).toBeNull();
  });

  it('deleteFeed calls admin_delete_feed with the feed id', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    let captured: Record<string, unknown> | undefined;
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_delete_feed') {
        captured = params;
        return Promise.resolve({ data: null, error: null });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    await env.ds.deleteFeed('feed-9');
    expect(captured).toEqual({ p_feed_id: 'feed-9' });
  });

  it('setFeedPaused calls admin_set_feed_paused with the id and flag', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    let captured: Record<string, unknown> | undefined;
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_set_feed_paused') {
        captured = params;
        return Promise.resolve({ data: null, error: null });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    await env.ds.setFeedPaused('feed-9', true);
    expect(captured).toEqual({ p_feed_id: 'feed-9', p_paused: true });
  });

  it('deleteUser calls admin_delete_user with the email', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    let captured: Record<string, unknown> | undefined;
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_delete_user') {
        captured = params;
        return Promise.resolve({ data: null, error: null });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    await env.ds.deleteUser('gone@example.com');
    expect(captured).toEqual({ p_email: 'gone@example.com' });
  });

  it('deleteUser surfaces a server error (e.g. the self-delete guard)', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_delete_user') {
        return Promise.resolve({
          data: null,
          error: { code: '42501', message: "you can't delete your own account" },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    // The RPC error (42501 self-delete guard) propagates rather than resolving.
    await expect(env.ds.deleteUser('me@example.com')).rejects.toThrow();
  });

  it('setUserBlocked calls admin_set_user_blocked with the email and flag', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    let captured: Record<string, unknown> | undefined;
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_set_user_blocked') {
        captured = params;
        return Promise.resolve({ data: null, error: null });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    await env.ds.setUserBlocked('spammer@example.com', true);
    expect(captured).toEqual({ p_email: 'spammer@example.com', p_blocked: true });
  });

  it('getSignupsEnabled returns the flag', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    // Backend reports sign-ups OFF.
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_signups_enabled') return Promise.resolve({ data: false, error: null });
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.getSignupsEnabled()).toBe(false);
  });

  it('setSignupsEnabled calls set_signups_enabled with the flag', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    let captured: Record<string, unknown> | undefined;
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'set_signups_enabled') {
        captured = params;
        return Promise.resolve({ data: null, error: null });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    await env.ds.setSignupsEnabled(false);
    expect(captured).toEqual({ p_enabled: false });
  });

  it('fetchFullText invokes the fulltext function and returns the extracted body', async () => {
    const env = setup();
    env.fake.invokeResult.current = {
      data: { status: 'ok', contentHtml: '<p>Full article</p>' },
      error: null,
    };
    const result = await env.ds.fetchFullText('i1');
    expect(result).toEqual({ status: 'ok', contentHtml: '<p>Full article</p>' });
    expect(env.fake.invokeCalls).toContainEqual({ name: 'fulltext', body: { itemId: 'i1' } });
  });

  it('fetchFullText passes through a soft status with no content', async () => {
    const env = setup();
    env.fake.invokeResult.current = {
      data: { status: 'auth', contentHtml: null },
      error: null,
    };
    expect(await env.ds.fetchFullText('i1')).toEqual({ status: 'auth', contentHtml: null });
  });

  it('fetchFullText passes the additive `retryable` flag through on an allowlist denial', async () => {
    const env = setup();
    env.fake.invokeResult.current = {
      data: { status: 'empty', contentHtml: null, retryable: true },
      error: null,
    };
    // Stays a silent `empty` (an old client renders it fine) but carries the
    // retryable flag so a later allowlist change re-checks it.
    expect(await env.ds.fetchFullText('i1')).toEqual({
      status: 'empty',
      contentHtml: null,
      retryable: true,
    });
  });

  it('fetchFullText omits `retryable` for a plain (non-denial) empty', async () => {
    const env = setup();
    env.fake.invokeResult.current = {
      data: { status: 'empty', contentHtml: null },
      error: null,
    };
    // A genuine empty keeps its plain shape (no retryable key → cached terminal).
    expect(await env.ds.fetchFullText('i1')).toEqual({ status: 'empty', contentHtml: null });
  });

  it('fetchFullText threads the additive `viaFallback` provenance flag through', async () => {
    const env = setup();
    env.fake.invokeResult.current = {
      data: { status: 'ok', contentHtml: '<p>Full article</p>', viaFallback: true },
      error: null,
    };
    expect(await env.ds.fetchFullText('i1')).toEqual({
      status: 'ok',
      contentHtml: '<p>Full article</p>',
      viaFallback: true,
    });
  });

  it('fetchFullText never reports `viaFallback` for a non-ok outcome', async () => {
    // A backend that (incorrectly) set viaFallback on a non-ok envelope must not
    // surface a provenance label — there's no body to attribute it to.
    const env = setup();
    env.fake.invokeResult.current = {
      data: { status: 'empty', contentHtml: null, viaFallback: true },
      error: null,
    };
    expect(await env.ds.fetchFullText('i1')).toEqual({ status: 'empty', contentHtml: null });
  });

  it('fetchFullText degrades an invoke error to unreachable', async () => {
    const env = setup();
    env.fake.invokeResult.current = { data: null, error: new Error('boom') };
    expect(await env.ds.fetchFullText('i1')).toEqual({ status: 'unreachable', contentHtml: null });
  });

  it('fetchFullText treats an unknown status as unreachable', async () => {
    const env = setup();
    env.fake.invokeResult.current = { data: { status: 'weird' }, error: null };
    expect(await env.ds.fetchFullText('i1')).toEqual({ status: 'unreachable', contentHtml: null });
  });

  it('fetchFullText retries once on a transient failure, then returns the success', async () => {
    // A single network blip must not drop the reader to the feed body until the
    // next open: fetchFullText resolves (never throws) so React Query can't retry
    // it — the retry lives in fetchFullText itself. First call errors →
    // `unreachable`, the retry succeeds → `ok`.
    const env = setup();
    env.ds.fullTextRetryDelayMs = 0; // no real wait in the test
    env.fake.invokeResultQueue.push(
      { data: null, error: new Error('blip') },
      { data: { status: 'ok', contentHtml: '<p>Full article</p>' }, error: null },
    );
    expect(await env.ds.fetchFullText('i1')).toEqual({
      status: 'ok',
      contentHtml: '<p>Full article</p>',
    });
    expect(env.fake.invokeCalls.filter((c) => c.name === 'fulltext')).toHaveLength(2);
  });

  it('fetchFullText retries a server-reported `unreachable`, then returns the success', async () => {
    // The 200 `{ status: 'unreachable' }` envelope is transient too — retry it
    // the same as a network blip.
    const env = setup();
    env.ds.fullTextRetryDelayMs = 0;
    env.fake.invokeResultQueue.push(
      { data: { status: 'unreachable', contentHtml: null }, error: null },
      { data: { status: 'ok', contentHtml: '<p>Full article</p>' }, error: null },
    );
    expect(await env.ds.fetchFullText('i1')).toEqual({
      status: 'ok',
      contentHtml: '<p>Full article</p>',
    });
    expect(env.fake.invokeCalls.filter((c) => c.name === 'fulltext')).toHaveLength(2);
  });

  it('fetchFullText gives up after the retry and returns the transient outcome', async () => {
    // Bounded: a persistently-down service is retried ONCE and then the
    // `unreachable` is returned (the reader shows the feed body, re-checks next
    // open) — never a hot loop.
    const env = setup();
    env.ds.fullTextRetryDelayMs = 0;
    env.fake.invokeResult.current = { data: null, error: new Error('still down') };
    expect(await env.ds.fetchFullText('i1')).toEqual({ status: 'unreachable', contentHtml: null });
    expect(env.fake.invokeCalls.filter((c) => c.name === 'fulltext')).toHaveLength(2);
  });

  it('fetchFullText does NOT retry a terminal `empty`', async () => {
    // A terminal outcome (ok/empty/auth) won't change on a retry, so return it
    // immediately rather than delaying the fall-back-to-feed-body.
    const env = setup();
    env.ds.fullTextRetryDelayMs = 0;
    env.fake.invokeResult.current = { data: { status: 'empty', contentHtml: null }, error: null };
    expect(await env.ds.fetchFullText('i1')).toEqual({ status: 'empty', contentHtml: null });
    expect(env.fake.invokeCalls.filter((c) => c.name === 'fulltext')).toHaveLength(1);
  });

  it('fetchFullText times out a hung invoke and degrades to a retryable unreachable', async () => {
    // A fetch frozen mid-flight (app suspended on mobile) may never settle after
    // resume. Uncapped, that corpse would wedge — via React Query's dedupe —
    // every later warm retry and the reader's own open. The invoke ceiling turns
    // it into the retryable `unreachable` so the retry loops actually loop.
    const env = setup();
    env.ds.fullTextRetryDelayMs = 0;
    env.ds.invokeTimeoutMs = 5;
    const signals: Array<AbortSignal | undefined> = [];
    env.fake.client.functions.invoke = (_name: string, opts?: { body?: unknown; method?: string; signal?: AbortSignal }) => {
      signals.push(opts?.signal);
      return new Promise<never>(() => {}); // hangs forever
    };
    expect(await env.ds.fetchFullText('i1')).toEqual({
      status: 'unreachable',
      contentHtml: null,
    });
    // The hung transport is genuinely ABORTED at the ceiling, not just abandoned
    // — an orphaned fetch would keep holding a connection slot while the retry
    // loop stacked more of them.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s?.aborted)).toBe(true);
  });

  it('fetchFullText maps a 404 (function not deployed / item hidden) to a terminal empty', async () => {
    // Frontend deployed ahead of the manual `fulltext` Edge Function deploy, or
    // RLS hid the item: a 404 that retrying can't fix. Map to a terminal `empty`
    // (cached in fullTextStaleTime) so the reader stops re-invoking — and, being
    // terminal, it is NOT retried.
    const env = setup();
    env.ds.fullTextRetryDelayMs = 0;
    const res = new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    env.fake.invokeResult.current = { data: null, error: new FunctionsHttpError(res) };
    expect(await env.ds.fetchFullText('i1')).toEqual({ status: 'empty', contentHtml: null });
    expect(env.fake.invokeCalls.filter((c) => c.name === 'fulltext')).toHaveLength(1);
  });

  it('getSummary invokes the summary function and maps an ok result', async () => {
    const env = setup();
    env.fake.invokeResult.current = {
      data: { status: 'ok', summary: 'A gist.' },
      error: null,
    };
    expect(await env.ds.getSummary('i1')).toEqual({ status: 'ok', summary: 'A gist.' });
    expect(env.fake.invokeCalls).toContainEqual({ name: 'summary', body: { itemId: 'i1' } });
  });

  it('getSummary passes the additive `retryable` flag through', async () => {
    const env = setup();
    env.fake.invokeResult.current = {
      data: { status: 'empty', summary: null, retryable: true },
      error: null,
    };
    expect(await env.ds.getSummary('i1')).toEqual({
      status: 'empty',
      summary: null,
      retryable: true,
    });
  });

  it('getSummary degrades a generic invoke error to unreachable (retryable)', async () => {
    const env = setup();
    env.fake.invokeResult.current = { data: null, error: new Error('boom') };
    expect(await env.ds.getSummary('i1')).toEqual({ status: 'unreachable', summary: null });
  });

  it('getSummary maps a 404 (function not deployed / item hidden) to a terminal empty', async () => {
    const env = setup();
    // Frontend deployed ahead of the manual `summary` Edge Function deploy, or
    // RLS hid the item: a 404 that retrying can't fix. Must be a NON-retryable
    // `empty` (terminal in summaryStaleTime) so the reader stops re-invoking.
    const res = new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    env.fake.invokeResult.current = { data: null, error: new FunctionsHttpError(res) };
    const result = await env.ds.getSummary('i1');
    expect(result).toEqual({ status: 'empty', summary: null });
    expect('retryable' in result).toBe(false);
  });

  it('getSummary retries once on a transient failure, then returns the success', async () => {
    // A single network blip must not sink the summary until the next mount:
    // getSummary resolves (never throws) so React Query can't retry it — the
    // retry lives in getSummary itself. First call errors → `unreachable`, the
    // retry succeeds → `ok`.
    const env = setup();
    env.ds.summaryRetryDelayMs = 0; // no real wait in the test
    env.fake.invokeResultQueue.push(
      { data: null, error: new Error('blip') },
      { data: { status: 'ok', summary: 'A gist.' }, error: null },
    );
    expect(await env.ds.getSummary('i1')).toEqual({ status: 'ok', summary: 'A gist.' });
    expect(env.fake.invokeCalls.filter((c) => c.name === 'summary')).toHaveLength(2);
  });

  it('getSummary retries a server-reported `unreachable`, then returns the success', async () => {
    // The 200 `{ status: 'unreachable' }` envelope (a Gemini / allowlist-read
    // hiccup) is transient too — retry it the same as a network blip.
    const env = setup();
    env.ds.summaryRetryDelayMs = 0;
    env.fake.invokeResultQueue.push(
      { data: { status: 'unreachable', summary: null }, error: null },
      { data: { status: 'ok', summary: 'A gist.' }, error: null },
    );
    expect(await env.ds.getSummary('i1')).toEqual({ status: 'ok', summary: 'A gist.' });
    expect(env.fake.invokeCalls.filter((c) => c.name === 'summary')).toHaveLength(2);
  });

  it('getSummary gives up after the retry and returns the transient outcome', async () => {
    // Bounded: a persistently-down service is retried ONCE and then the
    // `unreachable` is returned (the reader shows no card, re-checks next mount) —
    // never a hot loop, matching the disciplined retry policy elsewhere.
    const env = setup();
    env.ds.summaryRetryDelayMs = 0;
    env.fake.invokeResult.current = { data: null, error: new Error('still down') };
    expect(await env.ds.getSummary('i1')).toEqual({ status: 'unreachable', summary: null });
    expect(env.fake.invokeCalls.filter((c) => c.name === 'summary')).toHaveLength(2);
  });

  it('getSummary does NOT retry a terminal `unavailable` (key unset)', async () => {
    // `unavailable` (GOOGLE_API_KEY not configured) won't flip in a few hundred
    // ms, so retrying it just delays the (empty) card — return it immediately.
    const env = setup();
    env.ds.summaryRetryDelayMs = 0;
    env.fake.invokeResult.current = {
      data: { status: 'unavailable', summary: null, retryable: true },
      error: null,
    };
    expect(await env.ds.getSummary('i1')).toEqual({
      status: 'unavailable',
      summary: null,
      retryable: true,
    });
    expect(env.fake.invokeCalls.filter((c) => c.name === 'summary')).toHaveLength(1);
  });

  it('getSummary times out a hung invoke and degrades to a retryable unreachable', async () => {
    // Same suspension-corpse guard as fetchFullText: a hung summary invoke must
    // resolve to the retryable `unreachable` (after the in-place transient
    // retry), not hang the `['summary', id]` query forever.
    const env = setup();
    env.ds.summaryRetryDelayMs = 0;
    env.ds.invokeTimeoutMs = 5;
    const signals: Array<AbortSignal | undefined> = [];
    env.fake.client.functions.invoke = (_name: string, opts?: { body?: unknown; method?: string; signal?: AbortSignal }) => {
      signals.push(opts?.signal);
      return new Promise<never>(() => {}); // hangs forever
    };
    expect(await env.ds.getSummary('i1')).toEqual({ status: 'unreachable', summary: null });
    // The hung transport is genuinely aborted at the ceiling (see the fulltext
    // twin of this test for the rationale).
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s?.aborted)).toBe(true);
  });

  it('getSummary forwards the caller signal to the invoke and does not retry a cancelled fetch', async () => {
    // React Query's per-fetch signal is threaded through the queryFns, so
    // cancelQueries (the foreground-resume path) must abort the ACTUAL invoke —
    // not just reset query state — and the in-place transient retry must not
    // fire a second request whose result nobody wants.
    const env = setup();
    env.ds.summaryRetryDelayMs = 0;
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    env.fake.client.functions.invoke = (
      _name: string,
      opts?: { body?: unknown; method?: string; signal?: AbortSignal },
    ) => {
      signals.push(opts?.signal);
      // Cancel mid-flight, then fail the fetch the way an aborted transport does.
      controller.abort();
      return Promise.resolve({ data: null, error: new Error('aborted') });
    };
    expect(await env.ds.getSummary('i1', { signal: controller.signal })).toEqual({
      status: 'unreachable',
      summary: null,
    });
    // The caller's abort reached the transport-level signal…
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    // …and no second attempt was spent on a response nobody wants (length
    // asserted above).
  });

  it('refresh invokes the edge function with the feed id', async () => {
    const env = setup();
    await env.ds.refresh('feed-a');
    expect(env.fake.invokeCalls).toContainEqual({ name: 'refresh', body: { feedId: 'feed-a' } });
  });

  it('refresh throws when the edge function reports refreshed: 0 and debounced: 0 for a single feed', async () => {
    const env = setup();
    env.fake.invokeResult.current = { data: { refreshed: 0, debounced: 0 }, error: null };
    await expect(env.ds.refresh('feed-a')).rejects.toThrow('feed refresh failed');
  });

  it('refresh does not throw when the feed was debounced (refreshed: 0, debounced: 1)', async () => {
    const env = setup();
    env.fake.invokeResult.current = { data: { refreshed: 0, debounced: 1 }, error: null };
    await expect(env.ds.refresh('feed-a')).resolves.toBeUndefined();
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
    // The full read issues a high-water probe select before its page select,
    // and the probe tolerates its own failure by design. Re-arm the injection
    // when the page read goes out, so the hydration itself is what errors.
    fake.failSelectOnce('item_state');
    const realFrom = fake.client.from.bind(fake.client);
    let rearmed = false;
    fake.client.from = ((table: string) => {
      const q = realFrom(table) as { select: (c?: string, o?: unknown) => unknown };
      if (table !== 'item_state') return q;
      const realSelect = q.select.bind(q);
      q.select = (c?: string, o?: unknown) => {
        if (c !== 'updated_at' && !rearmed) {
          rearmed = true;
          fake.failSelectOnce('item_state');
        }
        return realSelect(c, o);
      };
      return q;
    }) as typeof fake.client.from;
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

  it('setOpenOriginal persists the open_original column and reads back', async () => {
    const env = setup();
    // Defaults to false (column absent on the seeded fake rows).
    let subs = await env.ds.getSubscriptions();
    expect(subs.find((s) => s.subscription.feedId === 'feed-b')!.subscription.openOriginal).toBe(false);
    await env.ds.setOpenOriginal('feed-b', true);
    subs = await env.ds.getSubscriptions();
    expect(subs.find((s) => s.subscription.feedId === 'feed-b')!.subscription.openOriginal).toBe(true);
    // Untouched feeds stay false.
    expect(subs.find((s) => s.subscription.feedId === 'feed-a')!.subscription.openOriginal).toBe(false);
  });

  it('setOpenMode writes both open-mode columns atomically and reads back', async () => {
    const env = setup();
    const subB = async () =>
      (await env.ds.getSubscriptions()).find(
        (s) => s.subscription.feedId === 'feed-b',
      )!.subscription;

    await env.ds.setOpenMode('feed-b', 'newshacker');
    expect((await subB()).openNewshacker).toBe(true);
    expect((await subB()).openOriginal).toBe(false);

    // Switching to original clears newshacker in the same update.
    await env.ds.setOpenMode('feed-b', 'original');
    expect((await subB()).openOriginal).toBe(true);
    expect((await subB()).openNewshacker).toBe(false);

    // Untouched feeds stay false on both flags.
    const a = (await env.ds.getSubscriptions()).find(
      (s) => s.subscription.feedId === 'feed-a',
    )!.subscription;
    expect(a.openOriginal).toBe(false);
    expect(a.openNewshacker).toBe(false);
  });

  it('setOpenOriginal still throws on a genuine (non-missing-column) write error', async () => {
    const env = setup();
    env.fake.failUpdateOnce('subscriptions', { code: '500', message: 'boom' });
    await expect(env.ds.setOpenOriginal('feed-a', true)).rejects.toThrow();
  });

  it('setMarkDoneOnOpen persists the mark_done_on_open column and reads back', async () => {
    const env = setup();
    let subs = await env.ds.getSubscriptions();
    expect(
      subs.find((s) => s.subscription.feedId === 'feed-b')!.subscription.markDoneOnOpen,
    ).toBe(false);
    await env.ds.setMarkDoneOnOpen('feed-b', true);
    subs = await env.ds.getSubscriptions();
    expect(
      subs.find((s) => s.subscription.feedId === 'feed-b')!.subscription.markDoneOnOpen,
    ).toBe(true);
    // Untouched feeds stay false; the flag is independent of the open-mode ones.
    expect(
      subs.find((s) => s.subscription.feedId === 'feed-a')!.subscription.markDoneOnOpen,
    ).toBe(false);
    expect(
      subs.find((s) => s.subscription.feedId === 'feed-b')!.subscription.openOriginal,
    ).toBe(false);
  });

  it('setMarkDoneOnOpen still throws on a genuine (non-missing-column) write error', async () => {
    const env = setup();
    env.fake.failUpdateOnce('subscriptions', { code: '500', message: 'boom' });
    await expect(env.ds.setMarkDoneOnOpen('feed-a', true)).rejects.toThrow();
  });

  it('setSubscriptionListLayout persists the list_layout column, reads back, and clears with null', async () => {
    const env = setup();
    const subB = async () =>
      (await env.ds.getSubscriptions()).find(
        (s) => s.subscription.feedId === 'feed-b',
      )!.subscription;
    expect((await subB()).listLayout).toBe(null);
    await env.ds.setSubscriptionListLayout('feed-b', 'excerpt');
    expect((await subB()).listLayout).toBe('excerpt');
    // Untouched feeds keep the app-wide default (null).
    const subs = await env.ds.getSubscriptions();
    expect(
      subs.find((s) => s.subscription.feedId === 'feed-a')!.subscription.listLayout,
    ).toBe(null);
    // Passing null clears the override.
    await env.ds.setSubscriptionListLayout('feed-b', null);
    expect((await subB()).listLayout).toBe(null);
  });

  it('setSubscriptionListLayout still throws on a genuine (non-missing-column) write error', async () => {
    const env = setup();
    env.fake.failUpdateOnce('subscriptions', { code: '500', message: 'boom' });
    await expect(
      env.ds.setSubscriptionListLayout('feed-a', 'excerpt'),
    ).rejects.toThrow();
  });

  it('threads sort + group options into the feed_items RPC', async () => {
    const env = setup();
    await env.ds.getHomeItems({ sort: 'oldest', groupByFeed: true });
    const call = env.fake.rpcCalls.find((c) => c.name === 'feed_items');
    expect(call?.params).toMatchObject({
      p_scope: 'home',
      p_sort: 'oldest',
      p_group_by_feed: true,
    });
  });

  it('defaults the RPC to newest-first, ungrouped', async () => {
    const env = setup();
    await env.ds.getHomeItems();
    const call = env.fake.rpcCalls.find((c) => c.name === 'feed_items');
    expect(call?.params).toMatchObject({ p_sort: 'newest', p_group_by_feed: false });
  });

  it('sorts oldest-first when asked (body order flips; pinned stays on top)', async () => {
    const env = setup();
    const page = await env.ds.getHomeItems({ sort: 'oldest' });
    // i2 pinned still leads; body now oldest-first: i3 (day 3) before i6 (day 6).
    expect(ids(page.items)).toEqual(['i2', 'i3', 'i6']);
  });

  it('groups by feed in subscription order, pinned at the top of its section', async () => {
    const env = setup();
    // Pin a feed-b item so we can see it lead feed-b's section rather than the list.
    env.fake.store.item_state.push(
      mkState('i3', { pinned: true, pinned_at: iso(15) }),
    );
    const page = await env.ds.getHomeItems({ groupByFeed: true });
    // feed-a (sort 0): i2 pinned, then i6. feed-b (sort 1): i3 pinned (top of its
    // own section, not lifted above feed-a).
    expect(ids(page.items)).toEqual(['i2', 'i6', 'i3']);
  });

  it('fetches each feed section in full — no per-feed cap sent, everything accepted (group by feed)', async () => {
    const env = setup();
    // An extra, older feed-a body item so there's depth to carry: feed-a body
    // is i6 (day 6) then i9 (day 1).
    env.fake.store.items.push(mkItem('i9', 'feed-a', 1, 'Old A'));
    // The grouped read sends no fetch cap — the server decides what each
    // section carries (today: its full listable set) and the client accepts
    // every returned row. feed-a → i2 (pinned) + i6 + i9; feed-b → i3.
    const page = await env.ds.getHomeItems({ groupByFeed: true });
    expect(ids(page.items)).toEqual(['i2', 'i6', 'i9', 'i3']);
    // The grouped read is a single deep page (no global next cursor).
    expect(page.nextCursor).toBeNull();
    // No client-side cap was threaded to the RPC.
    const call = env.fake.rpcCalls.find((c) => c.name === 'feed_items');
    expect(call?.params).toMatchObject({ p_group_by_feed: true });
    expect('p_per_feed_limit' in (call?.params ?? {})).toBe(false);
  });

  it('keeps tied feed sections contiguous (no interleaving / duplicate headers)', async () => {
    // Two feeds sharing a sort ordinal (reachable after unsubscribe+subscribe
    // reuses an index) must still emit as two contiguous runs, not interleaved —
    // otherwise ItemList would render duplicate headers/More for the split feed.
    const tables: FakeTables = {
      feeds_public: [
        { id: 'feed-x', site_url: '', title: 'X', error_count: 0, last_error: null, last_fetched_at: null, next_fetch_at: null, fetch_interval_s: 1800, created_at: null },
        { id: 'feed-y', site_url: '', title: 'Y', error_count: 0, last_error: null, last_fetched_at: null, next_fetch_at: null, fetch_interval_s: 1800, created_at: null },
      ],
      subscriptions: [
        { feed_id: 'feed-x', folder: null, title_override: null, muted: false, sort: 0 },
        { feed_id: 'feed-y', folder: null, title_override: null, muted: false, sort: 0 }, // tie
      ],
      items: [
        mkItem('x1', 'feed-x', 2, 'X one'), mkItem('x2', 'feed-x', 1, 'X two'),
        mkItem('y1', 'feed-y', 2, 'Y one'), mkItem('y2', 'feed-y', 1, 'Y two'),
      ],
      item_state: [],
      folders: [],
    };
    const { ds } = setup(tables);
    const page = await ds.getHomeItems({ groupByFeed: true });
    const feedSeq = page.items.map((fi) => fi.item.feedId);
    expect(feedSeq).toHaveLength(4);
    // Collapsing consecutive duplicates yields one run per feed (== distinct
    // feeds); an interleaved [x,y,x,y] would collapse to 4 runs.
    const runs = feedSeq.filter((f, i) => i === 0 || f !== feedSeq[i - 1]);
    expect(runs).toHaveLength(new Set(feedSeq).size);
  });

  it('pages grouped reads past the row cap (offset threaded, not forced to 0)', async () => {
    const env = setup();
    // A cursor on a grouped read continues from that offset so the next batch
    // of feed-sections isn't dropped when an account overflows the row cap.
    await env.ds.getHomeItems({ groupByFeed: true, cursor: '1000' });
    const call = env.fake.rpcCalls.find((c) => c.name === 'feed_items');
    expect(call?.params).toMatchObject({ p_offset: 1000, p_group_by_feed: true });
  });

  it('never sends p_per_feed_limit — the server decides the fetch cap, not the client', async () => {
    // Every read keeps the 7-arg payload: the client never dictates a per-feed
    // fetch cap. The RPC's own default applies, so a future cap is a
    // server-side migration with no client change (and the 7-arg call resolves
    // against every deployed feed_items version).
    const env = setup();
    await env.ds.getHomeItems(); // flat
    await env.ds.getFeedItems('feed-a'); // single feed
    await env.ds.getHomeItems({ groupByFeed: true }); // grouped
    const calls = env.fake.rpcCalls.filter((c) => c.name === 'feed_items');
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) {
      expect('p_per_feed_limit' in c.params).toBe(false);
    }
  });

  it('debugFeedProbe reports raw vs resolved grouped rows, the per-feed split, and the flat page', async () => {
    const env = setup();
    const probe = await env.ds.debugFeedProbe();
    expect(probe.error).toBeUndefined();
    // Grouped windowed read: feed-a = i2 (pinned, exempt) + i6; feed-b = i3.
    expect(probe.groupedRawRows).toBe(3);
    expect(probe.groupedResolvedRows).toBe(3);
    expect(probe.perFeed).toEqual([
      { title: 'Alpha Blog', rows: 2 },
      { title: 'Beta News', rows: 1 },
    ]);
    // Flat first page over the same data.
    expect(probe.flatResolvedRows).toBe(3);
  });

  it('debugFeedProbe runs under the caller\'s active sort (same RPC path as the view)', async () => {
    const env = setup();
    await env.ds.debugFeedProbe('oldest');
    const grouped = env.fake.rpcCalls.find(
      (c) => c.name === 'feed_items' && c.params.p_group_by_feed,
    );
    expect(grouped?.params).toMatchObject({ p_sort: 'oldest' });
    const flat = env.fake.rpcCalls.find(
      (c) => c.name === 'feed_items' && !c.params.p_group_by_feed,
    );
    expect(flat?.params).toMatchObject({ p_sort: 'oldest' });
  });

  it('debugFeedProbe probes the folder scope when Home is scoped to a folder', async () => {
    const env = setup();
    await env.ds.debugFeedProbe('newest', 'Tech');
    const grouped = env.fake.rpcCalls.find(
      (c) => c.name === 'feed_items' && c.params.p_group_by_feed,
    );
    expect(grouped?.params).toMatchObject({ p_scope: 'folder', p_folder: 'Tech' });
    const flat = env.fake.rpcCalls.find(
      (c) => c.name === 'feed_items' && !c.params.p_group_by_feed,
    );
    expect(flat?.params).toMatchObject({ p_scope: 'folder', p_folder: 'Tech' });
  });

  it('debugFeedProbe surfaces a malformed row shape as its Error instead of miscounting it', async () => {
    const env = setup();
    const rpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) =>
      name === 'feed_items' && params?.p_group_by_feed
        ? Promise.resolve({ data: [{ item: { id: 'i2' } }], error: null })
        : rpc(name, params)) as typeof env.fake.client.rpc;
    const probe = await env.ds.debugFeedProbe();
    expect(probe.error).toContain('missing expected item fields');
    // The raw count still reports what came back; nothing is counted resolved.
    expect(probe.groupedRawRows).toBe(1);
    expect(probe.groupedResolvedRows).toBe(0);
  });

  it('debugFeedProbe captures a failing read as an error instead of throwing', async () => {
    const env = setup();
    const rpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) =>
      name === 'feed_items' && params?.p_group_by_feed
        ? Promise.resolve({ data: null, error: { code: '57014', message: 'statement timeout' } })
        : rpc(name, params)) as typeof env.fake.client.rpc;
    const probe = await env.ds.debugFeedProbe();
    expect(probe.error).toContain('statement timeout');
    expect(probe.groupedRawRows).toBeNull();
  });

  it('getFeedUnreadCounts: per-feed unread, excluding done/hidden, keeping pinned-unopened', async () => {
    const env = setup();
    // feed-a items: i1 (Hidden), i2 (Pinned), i6. feed-b: i3, i4 (Done).
    const counts = await env.ds.getFeedUnreadCounts(['feed-a', 'feed-b']);
    // feed-a: i1 hidden (out), i2 pinned-unopened (in), i6 (in) → 2.
    // feed-b: i3 (in), i4 done (out) → 1.
    expect(counts).toEqual({ 'feed-a': 2, 'feed-b': 1 });
  });

  it('getFeedUnreadCounts: an opened (un-pinned) item stops counting', async () => {
    const env = setup();
    env.fake.store.item_state.push(mkState('i6', { opened: true, opened_at: recent }));
    // feed-a: i2 pinned (in), i6 now opened and un-pinned (out) → 1.
    expect((await env.ds.getFeedUnreadCounts(['feed-a']))['feed-a']).toBe(1);
  });

  it('getFeedUnreadCounts: batches the feed-id list to stay under the row cap', async () => {
    const env = setup();
    // 250 ids → 2 RPC batches (chunk size 200), so no single response (one row
    // per feed) can be truncated by the PostgREST row cap.
    const ids = Array.from({ length: 250 }, (_, i) => `f${i}`);
    await env.ds.getFeedUnreadCounts(ids);
    const calls = env.fake.rpcCalls.filter((c) => c.name === 'feed_unread_counts');
    expect(calls.length).toBe(2);
  });

  it('getFeedUnreadCounts: a pinned item still counts after being opened', async () => {
    const env = setup();
    // i2 is already pinned in the seed; mark it opened too.
    const s = env.fake.store.item_state.find((r) => r.item_id === 'i2')!;
    s.opened = true;
    s.opened_at = recent;
    // feed-a: i2 pinned-and-opened still counts, plus i6 → 2.
    expect((await env.ds.getFeedUnreadCounts(['feed-a']))['feed-a']).toBe(2);
  });

  it('reorderSubscriptions reassigns each subscription sort atomically via one RPC', async () => {
    const env = setup();
    await env.ds.reorderSubscriptions(['feed-c', 'feed-a', 'feed-b']);
    // One transactional RPC, not N per-row UPDATEs (0017).
    expect(env.fake.rpcCalls).toContainEqual({
      name: 'reorder_subscriptions',
      params: { p_feed_ids: ['feed-c', 'feed-a', 'feed-b'] },
    });
    const subs = await env.ds.getSubscriptions();
    expect(subs.map((s) => s.subscription.feedId)).toEqual([
      'feed-c', 'feed-a', 'feed-b',
    ]);
    expect(subs.map((s) => s.subscription.sort)).toEqual([0, 1, 2]);
  });

  it('a newly subscribed feed appends at the end of the sort order (not a 0 tie)', async () => {
    const env = setup();
    await env.ds.subscribe('https://new.example.com/feed');
    const subs = await env.ds.getSubscriptions();
    const added = subs.find((s) => s.subscription.feedId === 'feed-new')!;
    // Existing seed sorts are 0,1,2 → the new feed lands at 3, so Group-by-feed
    // can section it rather than tying every feed at the schema default 0.
    expect(added.subscription.sort).toBe(3);
  });

  it('subscribe maps the feed-cap SQLSTATE (53400) to AddFeedError("feed-limit")', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'subscribe_to_feed') {
        return Promise.resolve({
          data: null,
          error: { code: '53400', message: 'subscription limit reached (max 100 feeds)' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;

    await expect(env.ds.subscribe('https://new.example.com/feed')).rejects.toMatchObject({
      name: 'AddFeedError',
      kind: 'feed-limit',
    });
  });

  it('importOpml stops early once the account hits the feed cap (skips the rest)', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      // First new feed subscribes; every later one is rejected at the cap.
      if (name === 'subscribe_to_feed' && params?.p_url !== 'https://one.example.com/feed') {
        return Promise.resolve({
          data: null,
          error: { code: '53400', message: 'subscription limit reached (max 100 feeds)' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;

    const xml = `<opml><body>
      <outline type="rss" xmlUrl="https://one.example.com/feed" />
      <outline type="rss" xmlUrl="https://two.example.com/feed" />
      <outline type="rss" xmlUrl="https://three.example.com/feed" />
    </body></opml>`;
    const result = await env.ds.importOpml(xml);
    // one → added; two hits the cap and breaks; two + three counted as skipped.
    expect(result).toEqual({ added: 1, skipped: 2 });
    // The doomed third subscribe was never attempted (loop broke at the cap).
    expect(
      env.fake.rpcCalls.some(
        (c) => c.name === 'subscribe_to_feed' && c.params?.p_url === 'https://three.example.com/feed',
      ),
    ).toBe(false);
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

  it('importOpml routes a Google News url through discover and skips it when blocked', async () => {
    const env = setup();
    const res = new Response(
      JSON.stringify({ error: "Google News feeds aren't available on this account.", code: 'blocked' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    );
    env.fake.invokeResult.current = { data: null, error: new FunctionsHttpError(res) };
    const xml = `<opml><body>
      <outline type="rss" xmlUrl="https://news.google.com/rss/search?q=x" />
    </body></opml>`;
    const result = await env.ds.importOpml(xml);
    // Blocked by the gate → skipped, and it went through discover, never a
    // direct subscribe_to_feed (the bypass the gate is meant to close).
    expect(result).toEqual({ added: 0, skipped: 1 });
    expect(env.fake.invokeCalls).toContainEqual({
      name: 'discover',
      body: { url: 'https://news.google.com/rss/search?q=x' },
    });
    expect(env.fake.rpcCalls.some((c) => c.name === 'subscribe_to_feed')).toBe(false);
  });

  it('importOpml subscribes a Google News url that discover allows', async () => {
    const env = setup();
    env.fake.invokeResult.current = {
      data: {
        candidates: [
          { feedUrl: 'https://news.google.com/rss/search?q=x', title: 'G', siteUrl: null, sample: [] },
        ],
      },
      error: null,
    };
    const xml = `<opml><body>
      <outline type="rss" xmlUrl="https://news.google.com/rss/search?q=x" />
    </body></opml>`;
    const result = await env.ds.importOpml(xml);
    expect(result).toEqual({ added: 1, skipped: 0 });
    expect(env.fake.rpcCalls).toContainEqual({
      name: 'subscribe_to_feed',
      params: { p_url: 'https://news.google.com/rss/search?q=x', p_folder: null },
    });
  });

  it('importOpml skips an entry whose subscribe fails and continues with the rest', async () => {
    // Regression: only the Google News branch caught subscribe failures, so one
    // dead URL (or transient RPC 500) aborted the whole import mid-file —
    // earlier entries were already committed, later ones were never attempted,
    // and the caller saw a rejection instead of a result.
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'subscribe_to_feed' && params?.p_url === 'https://dead.example.com/feed') {
        return Promise.resolve({ data: null, error: { code: '500', message: 'boom' } });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;

    const xml = `<opml><body>
      <outline type="rss" xmlUrl="https://first.example.com/feed" />
      <outline type="rss" xmlUrl="https://dead.example.com/feed" />
      <outline type="rss" xmlUrl="https://third.example.com/feed" />
    </body></opml>`;
    const result = await env.ds.importOpml(xml);
    expect(result).toEqual({ added: 2, skipped: 1 });
    // The entry after the failing one was still attempted.
    expect(env.fake.rpcCalls).toContainEqual({
      name: 'subscribe_to_feed',
      params: { p_url: 'https://third.example.com/feed', p_folder: null },
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

describe('SupabaseDataSource — empty-feed caught-up confirmation', () => {
  const PROBE = 'https://x.supabase.co/auth/v1/health';

  function emptyTables(): FakeTables {
    return { feeds_public: [], subscriptions: [], items: [], item_state: [], folders: [] };
  }

  afterEach(() => {
    _resetNetworkStatusForTests(); // clears the probe URL + connectivity state
    vi.unstubAllGlobals();
  });

  it('throws on an empty feed when the backend is unreachable, rather than reporting caught up', async () => {
    // The feed_items RPC returns empty — but if that empty came from the SW cache
    // while the backend is down, claiming "all caught up" would be a lie. The live
    // probe fails, so the read must error (→ the view shows the down/offline
    // miss-state) instead of resolving to an empty page.
    const { ds } = setup(emptyTables());
    setConnectivityProbeUrl(PROBE);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    await expect(ds.getHomeItems()).rejects.toThrow(/caught up/i);
  });

  it('resolves to the empty page when the live probe confirms the backend is reachable', async () => {
    const { ds } = setup(emptyTables());
    setConnectivityProbeUrl(PROBE);
    const fetchMock = vi.fn(async () => ({})); // any resolved response proves reachability
    vi.stubGlobal('fetch', fetchMock);

    const page = await ds.getHomeItems();
    expect(page.items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(PROBE, expect.objectContaining({ method: 'GET' }));
  });

  it('does not probe or throw for an empty feed in mock/unconfigured mode (no backend to be down)', async () => {
    const { ds } = setup(emptyTables());
    // No probe URL configured (reset leaves it null).
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const page = await ds.getHomeItems();
    expect(page.items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not probe a non-empty feed — there is no caught-up claim to confirm', async () => {
    const { ds } = setup(); // seeded → home has items
    setConnectivityProbeUrl(PROBE);
    const fetchMock = vi.fn(async () => ({}));
    vi.stubGlobal('fetch', fetchMock);

    const page = await ds.getHomeItems();
    expect(page.items.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exportOpml emits the real feed URL from export_subscriptions (not the homepage)', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'export_subscriptions') {
        return Promise.resolve({
          data: [
            { feed_url: 'https://a.example.com/feed.xml', site_url: 'https://a.example.com', title: 'Alpha Blog' },
            { feed_url: 'https://b.example.com/rss?a=1&b=2', site_url: null, title: null },
          ],
          error: null,
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;

    const xml = await env.ds.exportOpml();
    // The RSS endpoint, not the site homepage, is what an importer subscribes to.
    expect(xml).toContain('xmlUrl="https://a.example.com/feed.xml"');
    expect(xml).toContain('htmlUrl="https://a.example.com"');
    // A null title falls back to "Untitled feed"; the & in the URL is escaped.
    expect(xml).toContain('xmlUrl="https://b.example.com/rss?a=1&amp;b=2"');
    expect(xml).toContain('text="Untitled feed"');
    expect(xml).toContain('<dateCreated>');
  });

  it('exportOpml falls back to the homepage URL against a backend without the RPC (PGRST202)', async () => {
    // The default fake returns PGRST202 for any unknown RPC, so export_subscriptions
    // is "not deployed" — the client must still produce a document, using the only
    // URL it can see (the display-safe site_url), rather than throwing.
    const { ds } = setup();
    const xml = await ds.exportOpml();
    expect(xml).toContain('xmlUrl="https://a.example.com"'); // site_url, the fallback
    expect(xml).toContain('title="Alpha Blog"');
    expect(xml).not.toContain('/feed.xml');
  });

  it('exportOpml rethrows a non-PGRST202 RPC error instead of masking it', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'export_subscriptions') {
        return Promise.resolve({ data: null, error: { code: '503', message: 'service unavailable' } });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    await expect(env.ds.exportOpml()).rejects.toThrow('service unavailable');
  });
});

describe('synced settings (user_settings, 0064)', () => {
  it('getSyncedSettings maps the row to camelCase and omits unset (null) columns', async () => {
    const { ds } = setup({
      ...seed(),
      user_settings: [
        {
          user_id: 'u1',
          item_sort: 'oldest',
          group_by_feed: true,
          hide_on_scroll: null,
          show_row_favicon: null,
          show_group_favicon: false,
          hide_sports_spoilers: null,
          auto_summarize_pinned: null,
        },
      ],
    });
    await expect(ds.getSyncedSettings()).resolves.toEqual({
      itemSort: 'oldest',
      groupByFeed: true,
      showGroupFavicon: false,
    });
  });

  it('getSyncedSettings returns {} when the account has no row yet', async () => {
    const { ds } = setup({ ...seed(), user_settings: [] });
    await expect(ds.getSyncedSettings()).resolves.toEqual({});
  });

  it('getSyncedSettings drops an unrecognized item_sort value (newer-client write)', async () => {
    const { ds } = setup({
      ...seed(),
      user_settings: [{ user_id: 'u1', item_sort: 'shuffled', group_by_feed: true }],
    });
    await expect(ds.getSyncedSettings()).resolves.toEqual({ groupByFeed: true });
  });

  it('setSyncedSettings upserts only the changed columns, merging into the row', async () => {
    const env = setup({
      ...seed(),
      user_settings: [{ user_id: 'u1', item_sort: 'oldest', group_by_feed: false }],
    });
    await env.ds.setSyncedSettings({ groupByFeed: true, hideOnScroll: true });
    // The merge touched only the pushed columns; item_sort survives.
    expect(env.fake.store.user_settings).toEqual([
      {
        user_id: 'u1',
        item_sort: 'oldest',
        group_by_feed: true,
        hide_on_scroll: true,
      },
    ]);
  });

  it('setSyncedSettings with an empty patch never issues a request', async () => {
    const env = setup({ ...seed(), user_settings: [] });
    await env.ds.setSyncedSettings({});
    expect(env.fake.store.user_settings).toEqual([]);
  });

  it('feature-detects a backend without the table on read: null, and stops calling (guardrail #11)', async () => {
    const env = setup(seed()); // no user_settings table seeded
    env.fake.failSelectOnce('user_settings', {
      code: 'PGRST205',
      message: "Could not find the table 'public.user_settings' in the schema cache",
    });
    await expect(env.ds.getSyncedSettings()).resolves.toBeNull();
    // Remembered: the next read short-circuits (no second select), and a write
    // REJECTS without touching the network. The rejection matters: a resolved
    // set() is the sync engine's cue to acknowledge the patch as delivered,
    // and a fake ack would strand the value device-local forever once the
    // manual `make migrate` lands — local == acked leaves no pending diff to
    // push (Codex P2 on #494).
    await expect(env.ds.getSyncedSettings()).resolves.toBeNull();
    expect(env.fake.selectCount('user_settings')).toBe(1);
    await expect(env.ds.setSyncedSettings({ groupByFeed: true })).rejects.toThrow('not deployed');
    expect(env.fake.store.user_settings ?? []).toEqual([]);
  });

  it('feature-detects a backend without the table on write: rejects and remembers', async () => {
    const env = setup({ ...seed(), user_settings: [] });
    env.fake.failUpdateOnce('user_settings', { code: 'PGRST205', message: 'no such table' });
    // Must NOT resolve — the change stays pending in the sync engine so it
    // pushes for real after the migration (see the read-side test above).
    await expect(env.ds.setSyncedSettings({ groupByFeed: true })).rejects.toThrow();
    // Remembered for the session: the follow-up read short-circuits to null.
    await expect(env.ds.getSyncedSettings()).resolves.toBeNull();
    expect(env.fake.selectCount('user_settings')).toBe(0);
  });

  it.each([
    ['read', '42703', 'column user_settings.hide_on_scroll_remove does not exist'],
    ['write', 'PGRST204', "Could not find the 'hide_on_scroll_remove' column"],
  ])(
    'falls back to the pre-0069 projection when only the new COLUMN is missing, on %s (guardrail #11)',
    async (_op, code, message) => {
      // Deploy-order skew: the client ships before `make migrate`. The read
      // names an explicit column list, so the un-migrated column fails the whole
      // row — but that must degrade ONLY the new preference. Every 0064 setting
      // has to keep hydrating and syncing (Codex P1 on #546).
      const env = setup({
        ...seed(),
        user_settings: [{ user_id: 'u1', group_by_feed: true }],
      });
      env.fake.failSelectOnce('user_settings', { code, message });
      env.fake.failUpdateOnce('user_settings', { code, message });

      // The retry on the older projection still hydrates the existing prefs.
      await expect(env.ds.getSyncedSettings()).resolves.toEqual({
        groupByFeed: true,
      });
      // …and an older setting still WRITES, rather than being blocked.
      await env.ds.setSyncedSettings({ groupByFeed: false });
      expect(env.fake.store.user_settings).toEqual([
        { user_id: 'u1', group_by_feed: false },
      ]);
      // The table itself was never marked unsupported — only the column.
      await expect(env.ds.getSyncedSettings()).resolves.toEqual({
        groupByFeed: false,
      });
    },
  );

  it('keeps the new pref pending (never fake-acks it) against a pre-0069 backend', async () => {
    const env = setup({ ...seed(), user_settings: [] });
    env.fake.failUpdateOnce('user_settings', {
      code: 'PGRST204',
      message: "Could not find the 'hide_on_scroll_remove' column",
    });

    // A patch carrying BOTH: the older column lands, the new one must not be
    // acked — a resolved set() would strand it device-local forever once the
    // migration arrives (local == acked leaves no diff to push).
    await expect(
      env.ds.setSyncedSettings({ groupByFeed: true, hideOnScrollRemove: false }),
    ).rejects.toThrow('hide_on_scroll_remove is not deployed');
    expect(env.fake.store.user_settings).toEqual([{ group_by_feed: true }]);

    // A patch carrying ONLY the new one short-circuits on the remembered
    // detection and still rejects, without a pointless failing request.
    await expect(
      env.ds.setSyncedSettings({ hideOnScrollRemove: false }),
    ).rejects.toThrow('hide_on_scroll_remove is not deployed');
  });

  it('never fake-acks the new pref when the column memo expires mid-write', async () => {
    // Codex P2 on #546: the memo is time-based and self-clearing, so two reads
    // inside one write can straddle its expiry — strip the column on the first,
    // then skip deferring on the second. A patch carrying ONLY the new pref
    // would send an empty payload and resolve, which the sync engine acks as
    // delivered: the value is then stranded device-local forever.
    const env = setup({ ...seed(), user_settings: [] });
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    env.fake.failUpdateOnce('user_settings', {
      code: 'PGRST204',
      message: "Could not find the 'hide_on_scroll_remove' column",
    });
    await expect(
      env.ds.setSyncedSettings({ hideOnScrollRemove: false }),
    ).rejects.toThrow('not deployed');

    // Land exactly on the expiry boundary for the next write.
    now.mockReturnValue(1_000_000 + 5 * 60 * 1000);
    // Whichever side of the boundary this write resolves on, it must not
    // RESOLVE without having sent the value.
    let acked = false;
    try {
      await env.ds.setSyncedSettings({ hideOnScrollRemove: false });
      acked = true;
    } catch {
      acked = false;
    }
    if (acked) {
      // Resolving is only honest if the value actually reached the backend.
      expect(env.fake.store.user_settings).toEqual([
        { hide_on_scroll_remove: false },
      ]);
    } else {
      expect(env.fake.store.user_settings ?? []).toEqual([]);
    }
    now.mockRestore();
  });

  it('picks up the new column once the migration lands and the memo expires', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    const env = setup({ ...seed(), user_settings: [] });
    env.fake.failSelectOnce('user_settings', {
      code: '42703',
      message: 'column user_settings.hide_on_scroll_remove does not exist',
    });
    await expect(env.ds.getSyncedSettings()).resolves.toEqual({});
    await expect(
      env.ds.setSyncedSettings({ hideOnScrollRemove: false }),
    ).rejects.toThrow('not deployed');

    // The operator runs `make migrate` while this tab stays open.
    now.mockReturnValue(1_000_000 + 6 * 60 * 1000);
    await env.ds.setSyncedSettings({ hideOnScrollRemove: false });
    expect(env.fake.store.user_settings).toEqual([
      { hide_on_scroll_remove: false },
    ]);
    now.mockRestore();
  });

  it('round-trips the hide_on_scroll_remove sub-setting (0069)', async () => {
    const env = setup({ ...seed(), user_settings: [] });
    await env.ds.setSyncedSettings({ hideOnScrollRemove: false });
    expect(env.fake.store.user_settings).toEqual([
      { hide_on_scroll_remove: false },
    ]);
    await expect(env.ds.getSyncedSettings()).resolves.toEqual({
      hideOnScrollRemove: false,
    });
  });

  it('setSyncedSettings rethrows a transient failure so the sync engine keeps the diff pending', async () => {
    const env = setup({ ...seed(), user_settings: [] });
    env.fake.failUpdateOnce('user_settings', { code: '503', message: 'service unavailable' });
    await expect(env.ds.setSyncedSettings({ groupByFeed: true })).rejects.toThrow();
    // NOT remembered as unsupported: the next write goes through.
    await env.ds.setSyncedSettings({ groupByFeed: true });
    expect(env.fake.store.user_settings).toEqual([{ group_by_feed: true }]);
  });

  it('re-probes after the unsupported memo expires, so a long-lived tab picks up the migration', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    // Backend predates 0064: detection remembered, reads short-circuit.
    const env = setup({ ...seed(), user_settings: [{ user_id: 'u1', group_by_feed: true }] });
    env.fake.failSelectOnce('user_settings', { code: 'PGRST205', message: 'no such table' });
    await expect(env.ds.getSyncedSettings()).resolves.toBeNull();
    await expect(env.ds.getSyncedSettings()).resolves.toBeNull();
    await expect(env.ds.setSyncedSettings({ groupByFeed: false })).rejects.toThrow('not deployed');
    expect(env.fake.selectCount('user_settings')).toBe(1);

    // The operator runs `make migrate` while this tab stays open. Once the
    // memo's retry window passes, the next reconcile goes back to the network
    // and the pending settings can drain — no reload required.
    now.mockReturnValue(1_000_000 + 6 * 60 * 1000);
    await expect(env.ds.getSyncedSettings()).resolves.toEqual({ groupByFeed: true });
    await env.ds.setSyncedSettings({ groupByFeed: false });
    expect(env.fake.store.user_settings).toEqual([{ user_id: 'u1', group_by_feed: false }]);
    now.mockRestore();
  });

  it('getSyncedSettings treats a transient read failure as "nothing to hydrate" without disabling sync', async () => {
    const env = setup({ ...seed(), user_settings: [{ user_id: 'u1', group_by_feed: true }] });
    env.fake.failSelectOnce('user_settings', { code: '503', message: 'service unavailable' });
    await expect(env.ds.getSyncedSettings()).resolves.toBeNull();
    // The next reconcile (focus/online) reads normally.
    await expect(env.ds.getSyncedSettings()).resolves.toEqual({ groupByFeed: true });
  });
});

describe('newshacker link probe (getNewshackerLink)', () => {
  /** A SupabaseDataSource whose only wired RPC is `newshacker_link_status`,
   * answering with whatever this test wants. */
  function withLinkRpc(answer: () => { data?: unknown; error?: unknown; status?: number }) {
    const fake = makeFakeSupabase(seed());
    const realRpc = fake.client.rpc.bind(fake.client);
    fake.client.rpc = ((name: string, params?: Record<string, unknown>) =>
      name === 'newshacker_link_status'
        ? { then: (onF: (v: unknown) => unknown) => Promise.resolve(answer()).then(onF) }
        : realRpc(name, params)) as typeof fake.client.rpc;
    return new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
  }

  it('reports the link when the RPC answers', async () => {
    await expect(withLinkRpc(() => ({ data: true })).getNewshackerLink()).resolves.toEqual({
      linked: true,
      supported: true,
    });
    await expect(withLinkRpc(() => ({ data: false })).getNewshackerLink()).resolves.toEqual({
      linked: false,
      supported: true,
    });
  });

  it('reports unsupported (not an error) on a backend without the 0050 RPC', async () => {
    const ds = withLinkRpc(() => ({
      error: { code: 'PGRST202', message: 'unknown rpc' },
    }));
    await expect(ds.getNewshackerLink()).resolves.toEqual({
      linked: false,
      supported: false,
    });
  });

  // The regression this section exists for: a transient failure used to resolve
  // as `{ linked: false }`, which React Query caches as a real answer. Because
  // useNewshackerSync mounts once at the App root and never remounts, that
  // stranded BOTH mirror directions off for the whole session. It must reject so
  // the query can retry and re-probe instead.
  it.each([
    ['offline / network blip', { error: { message: 'Failed to fetch' } }],
    ['auth blip while the JWT refreshes', { error: { message: 'JWT expired' }, status: 401 }],
    ['backend error', { error: { message: 'internal' }, status: 500 }],
  ])('throws rather than reporting "not linked" on a %s', async (_label, answer) => {
    const ds = withLinkRpc(() => answer);
    await expect(ds.getNewshackerLink()).rejects.toThrow();
  });
});

describe('item_state hydrate — live-window filter', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  /** Hydrate with only item_state seeded, and report which ids landed. */
  async function hydratedIds(rows: Array<ReturnType<typeof mkState>>) {
    const tables = seed();
    tables.item_state = rows;
    const { ds } = setup(tables);
    await ds.resyncState();
    return new Set(Object.keys(Object.fromEntries(ds.stateStore.entries())));
  }

  it('drops rows whose every clock has aged out, and keeps the permanent states', async () => {
    const got = await hydratedIds([
      // Opened once, months ago, never touched again — the shape that dominates
      // a long-lived account and the whole reason the table balloons.
      mkState('old-open', { opened: true, opened_at: ago(200 * DAY) }),
      mkState('old-done', { done: true, done_at: ago(90 * DAY) }),
      // Pinned/favorite are permanent: kept however old the clock is.
      mkState('ancient-pin', { pinned: true, pinned_at: ago(400 * DAY) }),
      mkState('ancient-fav', { favorite: true, favorite_at: ago(400 * DAY) }),
      // Recent activity stays.
      mkState('fresh-open', { opened: true, opened_at: ago(2 * DAY) }),
    ]);
    expect(got).toEqual(new Set(['ancient-pin', 'ancient-fav', 'fresh-open']));
  });

  // A row's clocks are only ever stamped by an action on that item (a mutation
  // stamps the action field AND its exclusivity-cleared siblings with the SAME
  // `now`), so the newest of the five IS the item's last-touched time. "Stale on
  // all five" therefore just means "untouched for the window" — which is why the
  // filter still sheds the bulk of a long-lived account.
  it('keeps a row on ONE recent clock even when every flag reads false', async () => {
    const got = await hydratedIds([
      // Un-pinned yesterday: nothing is true, but pinned_at is load-bearing —
      // it's what makes a stale offline replay lose the LWW compare (0023).
      mkState('just-unpinned', { pinned_at: ago(1 * DAY) }),
      // Same row shape, but the un-pin was long ago: nothing left to protect.
      mkState('long-unpinned', { pinned_at: ago(200 * DAY) }),
      // Opened long ago but dismissed recently — one fresh clock is enough.
      mkState('stale-open-fresh-done', {
        opened: true, opened_at: ago(200 * DAY),
        done: true, done_at: ago(3 * DAY),
      }),
    ]);
    expect(got).toEqual(new Set(['just-unpinned', 'stale-open-fresh-done']));
  });

  it('reaches a day past the render-time TTL so clock skew cannot drop a live row', async () => {
    // withRetention collapses Done at 30d; the read must not have already
    // dropped the row by then, or a still-rendering item would vanish.
    const got = await hydratedIds([
      mkState('just-inside-ttl', { done: true, done_at: ago(29 * DAY) }),
      mkState('just-past-ttl', { done: true, done_at: ago(30.5 * DAY) }),
      mkState('past-the-margin', { done: true, done_at: ago(32 * DAY) }),
    ]);
    expect(got).toEqual(new Set(['just-inside-ttl', 'just-past-ttl']));
  });
});

describe('item_state incremental hydrate (0070 cursor)', () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  /** Records each item_state read: the projection it asked for, and whether it
   * was a DELTA (carries the `updated_at >= cursor` filter) or a full read. */
  function setupCursor(tables: FakeTables = seed()) {
    const fake = makeFakeSupabase(tables);
    const reads: Array<{ cols?: string; delta: boolean }> = [];
    const realFrom = fake.client.from.bind(fake.client);
    // No withProbePassthrough here: this harness only RECORDS reads (nothing is
    // gated on their count), so the full read's high-water probe should show up
    // in the log like any other read.
    fake.client.from = ((table: string) => {
      const q = realFrom(table);
      if (table !== 'item_state') return q;
      const read: { cols?: string; delta: boolean } = { delta: false };
      const realSelect = q.select.bind(q);
      const realGte = q.gte.bind(q);
      q.select = ((c?: string, o?: { count?: string }) => {
        read.cols = c;
        reads.push(read);
        return realSelect(c, o);
      }) as typeof q.select;
      q.gte = ((c: string, v: unknown) => {
        if (c === 'updated_at') read.delta = true;
        return realGte(c, v);
      }) as typeof q.gte;
      return q;
    }) as typeof fake.client.from;
    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    return {
      ds,
      fake,
      reads,
      /** Reads since the last call — the constructor kicks a boot hydration, so
       * tests measure spans rather than absolute counts. */
      take: () => reads.splice(0, reads.length),
      state: () => Object.fromEntries(ds.stateStore.entries()),
    };
  }

  it('reads fully once, then only past the cursor', async () => {
    const env = setupCursor();
    await env.ds.resyncState();
    const first = env.take();
    // The very first read of the session is necessarily full — no cursor yet. A
    // full read is the high-water probe (bare cursor column, the ceiling the
    // cursor may not pass) followed by its page(s). Everything after it is a
    // delta, including the resync above (boot already established the cursor).
    expect(first[0].cols).toBe('updated_at');
    expect(first[0].delta).toBe(false);
    expect(first[1].delta).toBe(false);
    expect(first[1].cols).toContain('updated_at');
    expect(first.slice(2).every((r) => r.delta)).toBe(true);

    // Another device pins an item AFTER our cursor.
    env.fake.store.item_state.push(
      mkState('i6', { pinned: true, pinned_at: iso(0), updated_at: iso(0) }),
    );
    await env.ds.resyncState();

    const second = env.take();
    expect(second).toHaveLength(1);
    expect(second[0].delta).toBe(true);
    expect(env.state()['i6']?.pinned).toBe(true);
  });

  // The whole point: a delta returns only what changed, but rows it does NOT
  // mention must survive. Dropping them — as a full read legitimately does for
  // absent rows — would wipe the library on the first incremental pull.
  it('keeps rows the delta does not mention', async () => {
    const env = setupCursor();
    await env.ds.resyncState();
    const before = Object.keys(env.state()).sort();
    expect(before.length).toBeGreaterThan(1);
    env.take();

    env.fake.store.item_state.push(
      mkState('i6', { pinned: true, pinned_at: iso(0), updated_at: iso(0) }),
    );
    await env.ds.resyncState();

    expect(env.take().every((r) => r.delta)).toBe(true);
    expect(Object.keys(env.state()).sort()).toEqual([...before, 'i6'].sort());
  });

  it('re-reads a window before the cursor, so a late commit is not stepped over', async () => {
    const env = setupCursor();
    await env.ds.resyncState();
    env.take();
    // Stamped slightly BEFORE the cursor: the commit-order case, where a slower
    // transaction carries an earlier now() but commits after our read. A strict
    // `> cursor` would miss it permanently; the overlap catches it.
    env.fake.store.item_state.push(
      mkState('i6', { done: true, done_at: iso(5_000), updated_at: iso(5_000) }),
    );
    await env.ds.resyncState();
    expect(env.take().every((r) => r.delta)).toBe(true);
    expect(env.state()['i6']?.done).toBe(true);
  });

  it('falls back to full reads against a backend without 0070', async () => {
    const env = setupCursor();
    env.fake.failSelectOnce('item_state', { code: '42703' });
    await env.ds.resyncState();
    const first = env.take();
    // Asked with the column, was refused, retried without it — and the data landed.
    expect(first[0].cols).toContain('updated_at');
    expect(first.some((r) => r.cols && !r.cols.includes('updated_at'))).toBe(true);
    expect(env.state()['i2']?.pinned).toBe(true);

    // Latched for the session: never asks for the column again, never goes delta.
    await env.ds.resyncState();
    const later = env.take();
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((r) => !r.delta && !r.cols?.includes('updated_at'))).toBe(true);
  });

  it('stays on full reads for an account with no item_state at all', async () => {
    // No rows means no server-stamped value to seed a cursor from, and seeding it
    // from the local clock is precisely the skew bug the cursor rules avoid. A
    // full read of an empty table is one round trip anyway.
    const tables = seed();
    tables.item_state = [];
    const env = setupCursor(tables);
    await env.ds.resyncState();
    await env.ds.resyncState();
    expect(env.take().every((r) => !r.delta)).toBe(true);
    expect(env.state()).toEqual({});
  });

  // The one correction that works by ABSENCE rather than by a newer clock: the
  // server dropped the row, and hydrate rolls the optimistic local value back
  // because the response omits it. A delta can never say that, so this path has
  // to force a full read — otherwise the rollback silently stops happening.
  it('forces a full read for the permanent-reject correction', async () => {
    const env = setupCursor();
    await env.ds.resyncState();
    env.take();
    // Prove we are in incremental mode before the reject.
    await env.ds.resyncState();
    expect(env.take().every((r) => r.delta)).toBe(true);

    (env.ds as unknown as { forceFullGeneration: number }).forceFullGeneration += 1;
    await env.ds.resyncState();
    expect(env.take().every((r) => !r.delta)).toBe(true);
  });
});

describe('item_state incremental hydrate — window/cursor agreement', () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const DAY = 24 * 60 * 60 * 1000;

  // Codex P2 on #593: the full read applies the live window but the delta did
  // not, so the two disagreed about which rows exist. An aged-out row that gets
  // re-stamped (a replayed offline write keeps its OLD action clocks but takes a
  // NEW updated_at) was excluded from the full read yet hauled back by the
  // delta — re-adding rows withRetention only collapses again, and letting them
  // consume the page cap.
  it('does not haul back an aged-out row that was merely re-stamped', async () => {
    const fake = makeFakeSupabase(seed());
    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.resyncState();
    expect(Object.fromEntries(ds.stateStore.entries())['zz']).toBeUndefined();

    // Action clocks well outside the window, but written just now.
    fake.store.item_state.push(
      mkState('zz', { done: true, done_at: iso(200 * DAY), updated_at: iso(0) }),
    );
    await ds.resyncState();

    expect(Object.fromEntries(ds.stateStore.entries())['zz']).toBeUndefined();
  });

  it('still delivers a row that newly enters the window', async () => {
    // The other side of that filter: entering the window requires a write, and
    // a write always advances updated_at, so a newly-live row is past the cursor
    // and still matches. This is what makes filtering the delta safe.
    const fake = makeFakeSupabase(seed());
    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.resyncState();

    fake.store.item_state.push(
      mkState('zz', { pinned: true, pinned_at: iso(0), updated_at: iso(0) }),
    );
    await ds.resyncState();

    expect(Object.fromEntries(ds.stateStore.entries())['zz']?.pinned).toBe(true);
  });
});

describe('item_state incremental hydrate — page-boundary and loss correction', () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  /** Track whether each item_state read was a delta (has the cursor filter). */
  function setupReads(tables: FakeTables = seed()) {
    const fake = makeFakeSupabase(tables);
    const reads: Array<{ delta: boolean }> = [];
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      const q = realFrom(table);
      if (table !== 'item_state') return q;
      const read = { delta: false };
      const realSelect = q.select.bind(q);
      const realGte = q.gte.bind(q);
      q.select = ((c?: string, o?: { count?: string }) => {
        reads.push(read);
        return realSelect(c, o);
      }) as typeof q.select;
      q.gte = ((c: string, v: unknown) => {
        if (c === 'updated_at') read.delta = true;
        return realGte(c, v);
      }) as typeof q.gte;
      return q;
    }) as never) as typeof fake.client.from;
    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    return { ds, fake, reads, take: () => reads.splice(0, reads.length) };
  }

  // Codex P2 on #593: `now()` is transaction start, so one transaction writing a
  // page's worth of rows (apply_newshacker_state caps its batch at exactly
  // ITEM_STATE_PAGE) stamps them all identically. The overlap re-reads that clump
  // every focus; asking for exactly a page made each read look like an overflow,
  // and since the cursor can never advance past the tie, it fell back to a full
  // read forever. Asking for one MORE than a page separates "full" from
  // "truncated".
  it('stays incremental when a whole page shares one timestamp', async () => {
    const tables = seed();
    const stamp = iso(1000);
    tables.item_state = Array.from({ length: 1000 }, (_, i) =>
      mkState(`bulk-${String(i).padStart(4, '0')}`, {
        done: true,
        done_at: stamp,
        updated_at: stamp,
      }),
    );
    const env = setupReads(tables);
    // Model PostgREST's own row ceiling — without it these cases prove nothing,
    // because the fake would happily return more rows than the real server ever
    // will and overflow detection would look like it works when it can't.
    env.fake.capRows('item_state', 1000);
    await env.ds.resyncState();
    env.take();

    // Two further focuses: both must stay on the delta path.
    await env.ds.resyncState();
    await env.ds.resyncState();
    const later = env.take();
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((r) => r.delta)).toBe(true);
  });

  it('still falls back to a full read when more than a page changed', async () => {
    const tables = seed();
    tables.item_state = [mkState('a', { done: true, done_at: iso(5000), updated_at: iso(5000) })];
    const env = setupReads(tables);
    // The server ceiling clips the response at exactly a page, so a row-count
    // test can never see overflow — only the header count can. Codex P1 on #593:
    // an undetected truncation applies a partial delta and advances the cursor
    // past the rows it dropped, losing them permanently.
    env.fake.capRows('item_state', 1000);
    await env.ds.resyncState();
    env.take();

    // More than ITEM_STATE_PAGE rows past the cursor — genuine overflow.
    const stamp = iso(0);
    for (let i = 0; i <= 1000; i++) {
      env.fake.store.item_state.push(
        mkState(`x-${String(i).padStart(4, '0')}`, {
          done: true,
          done_at: stamp,
          updated_at: stamp,
        }),
      );
    }
    await env.ds.resyncState();
    const reads = env.take();
    // The delta was attempted, overflowed, and a full read followed.
    expect(reads.some((r) => r.delta)).toBe(true);
    expect(reads.some((r) => !r.delta)).toBe(true);
  });

  // The other Codex P2: an LWW loss is corrected by ADOPTING the winner, but a
  // stale write replayed from a long-persisted outbox loses to a tombstone whose
  // clocks are ALSO aged out — so the winning row matches neither read's window
  // filter, and only the full read's drop-absent pass clears the optimistic
  // value. A delta would leave the rejected pin on screen all session.
  it('forces a full read for the LWW-loss correction', async () => {
    const env = setupReads();
    await env.ds.resyncState();
    await env.ds.resyncState();
    expect(env.take().some((r) => r.delta)).toBe(true);

    (env.ds as unknown as { forceFullGeneration: number }).forceFullGeneration += 1;
    await env.ds.resyncState();
    expect(env.take().every((r) => !r.delta)).toBe(true);
  });
});

describe('item_state forced full read survives a cursor advance', () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  // Codex P2 on #593. Hydrations are serialized, so a correction raised while
  // another read is in flight had its cleared cursor overwritten by that read's
  // own `advanceItemStateCursor` before the correction's read began — and the
  // correction then ran as a delta, which can never drop the absent optimistic
  // row it exists to remove. The constructor kicks boot hydration before the
  // outbox flushes, so a stale replay lands in exactly that window. The fix is
  // to latch the intent instead of encoding it in cursor state, which is what
  // this asserts: an intervening cursor advance must not defeat it.
  it('reads fully even after the cursor is re-advanced underneath it', async () => {
    const fake = makeFakeSupabase(seed());
    const reads: boolean[] = [];
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      const q = realFrom(table);
      if (table !== 'item_state') return q;
      const realSelect = q.select.bind(q);
      const realGte = q.gte.bind(q);
      q.select = ((c?: string, o?: { count?: string }) => {
        reads.push(false);
        return realSelect(c, o);
      }) as typeof q.select;
      q.gte = ((c: string, v: unknown) => {
        if (c === 'updated_at') reads[reads.length - 1] = true;
        return realGte(c, v);
      }) as typeof q.gte;
      return q;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    const internals = ds as unknown as {
      forceFullGeneration: number;
      forceFullServed: number;
      itemStateCursor: string | null;
    };
    await ds.resyncState();

    // A correction raises the flag…
    internals.forceFullGeneration += 1;
    // …and a concurrent read lands first, re-advancing the cursor. Under the
    // old design (clear the cursor) this is precisely what silently downgraded
    // the correction back to a delta.
    internals.itemStateCursor = iso(0);

    reads.length = 0;
    await ds.resyncState();
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((wasDelta) => !wasDelta)).toBe(true);
    // Consumed, so ordinary focuses go back to being incremental.
    expect(internals.forceFullServed).toBe(internals.forceFullGeneration);
    reads.length = 0;
    await ds.resyncState();
    expect(reads.every((wasDelta) => wasDelta)).toBe(true);
  });
});

describe('item_state forced full read — overlapping corrections', () => {
  // Codex P2 on #593. A boolean latch loses the SECOND correction: raised while
  // a forced-full read is already running, it only re-sets an already-true flag,
  // and that read's completion clears it — so the second correction's own read
  // runs as a delta and reconciles nothing, leaving a wrong pin/done until a
  // cold boot. The generation counter makes each request distinct.
  it('does not let a completing read absorb a correction raised after it started', async () => {
    const fake = makeFakeSupabase(seed());
    const reads: boolean[] = [];
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = withProbePassthrough(realFrom, ((table: string) => {
      const q = realFrom(table);
      if (table !== 'item_state') return q;
      const realSelect = q.select.bind(q);
      const realGte = q.gte.bind(q);
      q.select = ((c?: string, o?: { count?: string }) => {
        reads.push(false);
        return realSelect(c, o);
      }) as typeof q.select;
      q.gte = ((c: string, v: unknown) => {
        if (c === 'updated_at') reads[reads.length - 1] = true;
        return realGte(c, v);
      }) as typeof q.gte;
      return q;
    }) as never) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    const internals = ds as unknown as {
      forceFullGeneration: number;
      forceFullServed: number;
    };
    await ds.resyncState();

    // Correction A is raised and served by a full read…
    internals.forceFullGeneration += 1;
    const servedByA = internals.forceFullGeneration;
    // …but correction B arrives while that read is still in flight, i.e. after
    // the read snapshotted its generation. Model that by bumping again before
    // the read that serves A is accounted for.
    internals.forceFullGeneration += 1;

    reads.length = 0;
    await ds.resyncState();
    expect(reads.every((wasDelta) => !wasDelta)).toBe(true);
    // B's request must still be outstanding after A's read completed, so the
    // NEXT read is full too rather than silently dropping to a delta.
    expect(internals.forceFullServed).toBeGreaterThanOrEqual(servedByA);

    internals.forceFullServed = servedByA; // as if only A's read had completed
    reads.length = 0;
    await ds.resyncState();
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((wasDelta) => !wasDelta)).toBe(true);
  });
});

describe('item_state full read — cursor cannot pass the pre-read high-water mark', () => {
  // Codex P2 on #593. A full read is many requests, each its own transaction, so
  // a row in an already-read page can be updated mid-read and be missed while a
  // row in a later page is updated afterwards and IS returned. Advancing to the
  // plain maximum would put the cursor past the missed update, and the next
  // delta (cursor minus the overlap) would never reach it again this session.
  const cursorOf = (ds: SupabaseDataSource) =>
    (ds as unknown as { itemStateCursor: string | null }).itemStateCursor;

  it('ignores rows stamped after the pre-read high-water mark', async () => {
    const tables = seed();
    const beforeRead = '2026-07-01T00:00:00+00:00';
    tables.item_state = [{ ...mkState('i2', { pinned: true, pinned_at: recent }), updated_at: beforeRead }];
    const fake = makeFakeSupabase(tables);
    const realFrom = fake.client.from.bind(fake.client);
    // The probe sees only the pre-read row; the PAGE read additionally returns a
    // row stamped later — exactly what a write landing mid-read looks like.
    const duringRead = '2026-07-01T00:05:00+00:00';
    fake.client.from = ((table: string) => {
      const q = realFrom(table) as { select: (c?: string, o?: unknown) => unknown };
      if (table !== 'item_state') return q;
      const realSelect = q.select.bind(q);
      q.select = (c?: string, o?: unknown) => {
        const chain = realSelect(c, o);
        if (c === 'updated_at') return chain;
        return {
          ...(chain as object),
          or: () => chain,
          order: () => chain,
          limit: () => chain,
          gt: () => chain,
          not: async () => {
            const res = (await (chain as { not: (...a: unknown[]) => Promise<unknown> }).not(
              'item_id',
              'eq',
              '00000000-0000-0000-0000-000000000000',
            )) as { data: unknown[]; error: unknown };
            return {
              ...res,
              data: [
                ...(res.data ?? []),
                { ...mkState('i6', { pinned: true, pinned_at: recent }), updated_at: duringRead },
              ],
            };
          },
        };
      };
      return q;
    }) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    await ds.resyncState();
    // The mid-read row was applied, but must NOT drag the cursor past the mark:
    // a row missed between pages could sit anywhere below it.
    expect(cursorOf(ds)).not.toBe(duringRead);
    expect(cursorOf(ds)).toBe(beforeRead);
  });

  it('leaves the cursor unadvanced when the high-water probe fails', async () => {
    const fake = makeFakeSupabase(seed());
    // Consumed by the probe, which is the full read's first select. Not 42703 —
    // that means "no such column" and latches the pre-0070 fallback instead.
    fake.failSelectOnce('item_state', { code: '08006', message: 'connection failure' });
    const ds = new SupabaseDataSource(
      'readmo:item-state:test',
      fake.client as unknown as SupabaseClient,
    );
    // The constructor's boot hydration is the read that fails the probe; don't
    // resync afterwards or a second, succeeding probe would seed the cursor.
    await new Promise((r) => setTimeout(r));
    // Rows still landed — the probe is non-fatal — but with no safe ceiling the
    // cursor stays put, so the next read is another full one.
    expect(Object.fromEntries(ds.stateStore.entries())['i2']?.pinned).toBe(true);
    expect(cursorOf(ds)).toBeNull();
  });
});
