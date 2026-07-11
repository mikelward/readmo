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
  return {
    user_id: 'u1', item_id,
    pinned: false, pinned_at: null, favorite: false, favorite_at: null,
    done: false, done_at: null, hidden: false, hidden_at: null,
    opened: false, opened_at: null, ...over,
  };
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
function itemStateReadStub(resolve: () => unknown): unknown {
  const chain = {
    select: () => chain,
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

  it('falls back to the legacy item columns when comments_url is missing (pre-0033 backend)', async () => {
    const env = setup();
    // Model a backend predating migration 0033: any select naming comments_url
    // 400s with undefined_column (42703), so the read drops that column and
    // retries with the legacy set rather than failing every item read.
    env.fake.failSelectWhenColumns('items', 'comments_url', { code: '42703' });
    const fi = await env.ds.getItem('i3');
    expect(fi?.item.title).toBe('Beta three');
    expect(fi?.item.commentsUrl).toBeNull();
    expect(env.fake.lastSelectCols('items')).not.toContain('comments_url');
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
    fake.client.from = ((table: string) => {
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
    }) as typeof fake.client.from;

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
    fake.client.from = ((table: string) => {
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
    }) as typeof fake.client.from;

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
    fake.client.from = ((table: string) => {
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
    }) as typeof fake.client.from;

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
    fake.client.from = ((table: string) => {
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
    }) as typeof fake.client.from;

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
    fake.client.from = ((table: string) => {
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
    }) as typeof fake.client.from;

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
    fake.client.from = ((table: string) => {
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
    }) as typeof fake.client.from;

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
    fake.client.from = ((table: string) => {
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
    }) as typeof fake.client.from;

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
    env.fake.client.from = ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      return itemStateReadStub(() => ({
        data: null,
        count: null,
        error: { message: 'offline' },
      })) as ReturnType<typeof realFrom>;
    }) as typeof env.fake.client.from;

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
    env.fake.client.from = ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      return itemStateReadStub(() => ({ data: [], count: null, error: null })) as ReturnType<
        typeof realFrom
      >;
    }) as typeof env.fake.client.from;

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
    env.fake.client.from = ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      repullStarted();
      return itemStateReadStub(() => Promise.reject(new Error('offline'))) as ReturnType<
        typeof realFrom
      >;
    }) as typeof env.fake.client.from;

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
    env.fake.client.from = ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      hungReadStarted();
      return itemStateReadStub(() => new Promise(() => {})) as ReturnType<typeof realFrom>;
    }) as typeof env.fake.client.from;

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
    fake.client.from = ((table: string) => {
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
    }) as typeof fake.client.from;

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
      fake.client.from = ((table: string) => {
        if (table !== 'item_state') return realFrom(table);
        // Hung item_state read: hydration never settles.
        return itemStateReadStub(() => new Promise(() => {})) as ReturnType<typeof realFrom>;
      }) as typeof fake.client.from;

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
    env.fake.client.from = ((table: string) => {
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
    }) as typeof env.fake.client.from;

    const a = env.ds.resyncState().catch(() => {}); // in flight (read #1)
    const b = env.ds.resyncState().catch(() => {}); // coalesces → sets pending
    await firstReadStarted; // read #1 has fired and failFirst is wired
    failFirst(); // read #1 rejects
    await Promise.all([a, b]);
    await retried; // a fresh resync (read #2) ran after the failure
    expect(resyncReads).toBe(2);
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
    fake.client.from = ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      return itemStateReadStub(() => ({
        data: null,
        count: null,
        error: { message: 'offline' },
      })) as ReturnType<typeof realFrom>;
    }) as typeof fake.client.from;

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
    fake.client.from = ((table: string) => {
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
    }) as typeof fake.client.from;

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
    fake.client.from = ((table: string) => {
      if (table !== 'item_state' || readsWork) return realFrom(table);
      return itemStateReadStub(() => ({
        data: null,
        count: null,
        error: { message: 'offline' },
      })) as ReturnType<typeof realFrom>;
    }) as typeof fake.client.from;

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

  it('getCapabilities feature-detects a backend without the RPC → all-false', async () => {
    // The fake returns a PGRST202 ("unknown rpc") error for get_capabilities (an
    // old backend that predates the migration). getCapabilities must fall back to
    // no capabilities rather than throwing, so an old backend behaves like
    // today — no chip, no /admin (guardrail #11).
    const env = setup();
    expect(await env.ds.getCapabilities()).toEqual({
      family: false,
      admin: false,
      allowlistArmed: false,
    });
  });

  it('getCapabilities rethrows a transient error instead of caching all-false', async () => {
    // A non-PGRST202 error (network blip / 5xx) must NOT be swallowed into a
    // permissive all-false: that would pin "gate open" for the 5-min staleTime
    // and let an off-list user issue fulltext calls. Rethrow so React Query
    // retries and keeps the prior value.
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

  it('getCapabilities maps can_manage_users, and reads false on a pre-0030 backend', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    // A 0030 backend returns the flag.
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

    // A pre-0030 backend's get_capabilities omits the column → false, so /admin
    // hides the block/delete/sign-up controls whose RPCs aren't deployed yet.
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

  it('listUsers maps rows and feature-detects a backend without the RPC', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    // First: a backend that has the RPC → mapped rows.
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
              // No `blocked` field — an old backend (pre-0030) → maps to false.
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

    // Then: an old backend without the RPC (PGRST202) → empty list, no throw.
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'list_users') {
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST202', message: 'unknown function' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.listUsers()).toEqual([]);
  });

  it('listFeedStatuses maps rows and feature-detects a backend without the RPC', async () => {
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

    // An old backend without the RPC (PGRST202) → empty list, no throw.
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_list_feeds') {
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST202', message: 'unknown function' },
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.listFeedStatuses()).toEqual([]);
  });

  it('listFeedStatuses reports an absent subscriber_count as unknown (null), not 0', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'admin_list_feeds') {
        // A backend that predates migration 0041 → rows omit subscriber_count.
        return Promise.resolve({
          data: [{ id: 'feed-1', title: 'A Feed', error_count: 0 }],
          error: null,
        });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    const [feed] = await env.ds.listFeedStatuses();
    expect(feed.subscriberCount).toBeNull();
    // Same rollout window: an absent `paused` maps to null ("pausing not
    // supported yet"), not a false that would offer a Pause with no RPC.
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

  it('getSignupsEnabled returns the flag, and feature-detects an old backend → true', async () => {
    const env = setup();
    const realRpc = env.fake.client.rpc.bind(env.fake.client);
    // Backend has the RPC and reports sign-ups OFF.
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_signups_enabled') return Promise.resolve({ data: false, error: null });
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.getSignupsEnabled()).toBe(false);

    // Old backend without the RPC (PGRST202) → defaults to open (true), no throw.
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_signups_enabled') {
        return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'unknown function' } });
      }
      return realRpc(name, params);
    }) as typeof env.fake.client.rpc;
    expect(await env.ds.getSignupsEnabled()).toBe(true);
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

  it('getSubscriptions falls back to the legacy columns when open_original is missing (pre-0027 backend)', async () => {
    const env = setup();
    // Optimistic before any read has proven the column absent.
    expect(env.ds.supportsOpenOriginal()).toBe(true);
    expect(env.ds.supportsOpenNewshacker()).toBe(true);
    // Model a pre-0027 backend: any select naming open_original errors with
    // undefined_column (42703), so both the full and the no-newshacker tiers
    // fail and the read drops to the legacy column set.
    env.fake.failSelectWhenColumns('subscriptions', 'open_original', { code: '42703' });
    const subs = await env.ds.getSubscriptions();
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s) => s.subscription.openOriginal === false)).toBe(true);
    expect(subs.every((s) => s.subscription.openNewshacker === false)).toBe(true);
    // The fallback marks both features unsupported so the UI hides the controls.
    expect(env.ds.supportsOpenOriginal()).toBe(false);
    expect(env.ds.supportsOpenNewshacker()).toBe(false);
  });

  it('getSubscriptions falls back to the pre-0034 columns when only open_newshacker is missing', async () => {
    const env = setup();
    expect(env.ds.supportsOpenNewshacker()).toBe(true);
    // Model a backend with 0027 but not 0034: only a projection naming
    // open_newshacker errors, so the read drops just that column and keeps
    // open_original.
    env.fake.failSelectWhenColumns('subscriptions', 'open_newshacker', { code: '42703' });
    const subs = await env.ds.getSubscriptions();
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s) => s.subscription.openNewshacker === false)).toBe(true);
    // open_original is still supported; only the newshacker option hides.
    expect(env.ds.supportsOpenOriginal()).toBe(true);
    expect(env.ds.supportsOpenNewshacker()).toBe(false);
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

  it('setOpenMode tolerates a pre-0034 backend: retries without open_newshacker', async () => {
    const env = setup();
    // The combined write naming open_newshacker 400s on a pre-0034 backend; the
    // data source retries with just open_original so reader/original still
    // persist, and records the column absent so the option hides.
    env.fake.failUpdateOnce('subscriptions', { code: 'PGRST204' });
    await expect(env.ds.setOpenMode('feed-b', 'original')).resolves.toBeUndefined();
    expect(env.ds.supportsOpenNewshacker()).toBe(false);
    const b = (await env.ds.getSubscriptions()).find(
      (s) => s.subscription.feedId === 'feed-b',
    )!.subscription;
    // The open_original half of the intent still landed via the retry.
    expect(b.openOriginal).toBe(true);
  });

  it('setOpenMode on a pre-0034 backend does not clobber open_original for a newshacker pick', async () => {
    const env = setup();
    const subB = async () =>
      (await env.ds.getSubscriptions()).find(
        (s) => s.subscription.feedId === 'feed-b',
      )!.subscription;
    // Feed starts in "open original".
    await env.ds.setOpenMode('feed-b', 'original');
    expect((await subB()).openOriginal).toBe(true);
    // The option is still showing (optimistic stale cache), but the backend
    // lacks open_newshacker: the write 400s. We can't honor newshacker, so the
    // existing open_original preference must be left intact — NOT cleared.
    env.fake.failUpdateOnce('subscriptions', { code: 'PGRST204' });
    await expect(env.ds.setOpenMode('feed-b', 'newshacker')).resolves.toBeUndefined();
    expect(env.ds.supportsOpenNewshacker()).toBe(false);
    expect((await subB()).openOriginal).toBe(true);
    expect((await subB()).openNewshacker).toBe(false);
  });

  it('reports open-original support after a normal subscriptions read', async () => {
    const env = setup();
    await env.ds.getSubscriptions();
    expect(env.ds.supportsOpenOriginal()).toBe(true);
  });

  it('setOpenOriginal no-ops (no throw) and marks support false when the column is missing', async () => {
    const env = setup();
    // A PATCH body naming a column absent from the schema cache returns
    // PostgREST's own PGRST204 (not the SELECT-path 42703), so the tolerant
    // write must recognize it. Model that pre-0027 / stale-schema rejection.
    env.fake.failUpdateOnce('subscriptions', { code: 'PGRST204' });
    // Must not reject — the client can't *require* the unshipped migration, even
    // if the control was shown from a cache-served render before a live probe.
    await expect(env.ds.setOpenOriginal('feed-a', true)).resolves.toBeUndefined();
    // Capability now reads false, so the Feeds page hides the control next render.
    expect(env.ds.supportsOpenOriginal()).toBe(false);
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

  it('getSubscriptions falls back to the pre-0037 columns when only mark_done_on_open is missing', async () => {
    const env = setup();
    expect(env.ds.supportsMarkDoneOnOpen()).toBe(true);
    // Model a backend with 0027/0034 but not 0037: only a projection naming
    // mark_done_on_open errors, so the read drops just that column and keeps the
    // open-mode columns.
    env.fake.failSelectWhenColumns('subscriptions', 'mark_done_on_open', {
      code: '42703',
    });
    const subs = await env.ds.getSubscriptions();
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s) => s.subscription.markDoneOnOpen === false)).toBe(true);
    // The open-mode columns are still supported; only the mark-done control hides.
    expect(env.ds.supportsMarkDoneOnOpen()).toBe(false);
    expect(env.ds.supportsOpenOriginal()).toBe(true);
    expect(env.ds.supportsOpenNewshacker()).toBe(true);
  });

  it('setMarkDoneOnOpen no-ops (no throw) and marks support false when the column is missing', async () => {
    const env = setup();
    env.fake.failUpdateOnce('subscriptions', { code: 'PGRST204' });
    await expect(env.ds.setMarkDoneOnOpen('feed-a', true)).resolves.toBeUndefined();
    expect(env.ds.supportsMarkDoneOnOpen()).toBe(false);
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

  it('getSubscriptions falls back to the pre-0051 columns when only list_layout is missing', async () => {
    const env = setup();
    expect(env.ds.supportsSubscriptionListLayout()).toBe(true);
    // Model a backend with 0027/0034/0037 but not 0051: only a projection naming
    // list_layout errors, so the read drops just that column and keeps the rest.
    env.fake.failSelectWhenColumns('subscriptions', 'list_layout', { code: '42703' });
    const subs = await env.ds.getSubscriptions();
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s) => s.subscription.listLayout === null)).toBe(true);
    // Only the card-style control hides; the older preferences stay supported.
    expect(env.ds.supportsSubscriptionListLayout()).toBe(false);
    expect(env.ds.supportsMarkDoneOnOpen()).toBe(true);
    expect(env.ds.supportsOpenOriginal()).toBe(true);
    expect(env.ds.supportsOpenNewshacker()).toBe(true);
  });

  it('setSubscriptionListLayout no-ops (no throw) and marks support false when the column is missing', async () => {
    const env = setup();
    env.fake.failUpdateOnce('subscriptions', { code: 'PGRST204' });
    await expect(
      env.ds.setSubscriptionListLayout('feed-a', 'excerpt'),
    ).resolves.toBeUndefined();
    expect(env.ds.supportsSubscriptionListLayout()).toBe(false);
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

  it('getFeedUnreadIds: returns the unread ids per feed, agreeing with the counts', async () => {
    const env = setup();
    const ids = await env.ds.getFeedUnreadIds(['feed-a', 'feed-b']);
    // feed-a: i1 hidden (out), i2 pinned + i6 (in); feed-b: i3 (in), i4 done (out).
    expect(new Set(ids!['feed-a'])).toEqual(new Set(['i2', 'i6']));
    expect(ids!['feed-b']).toEqual(['i3']);
    const counts = await env.ds.getFeedUnreadCounts(['feed-a', 'feed-b']);
    expect(ids!['feed-a'].length).toBe(counts['feed-a']);
    expect(ids!['feed-b'].length).toBe(counts['feed-b']);
  });

  it('getFeedUnreadIds: batches the feed-id list in smaller (per-item-safe) chunks', async () => {
    const env = setup();
    // One row per unread ITEM, not per feed, so the batch is 100 feeds (< the
    // 200 count-path chunk): 250 ids → 3 batches.
    const idList = Array.from({ length: 250 }, (_, i) => `f${i}`);
    await env.ds.getFeedUnreadIds(idList);
    const calls = env.fake.rpcCalls.filter((c) => c.name === 'feed_unread_ids');
    expect(calls.length).toBe(3);
  });

  it('getFeedUnreadIds: falls back (null) when a batch comes back at the row cap (possibly truncated)', async () => {
    const env = setup();
    const rpc = env.fake.client.rpc.bind(env.fake.client);
    // Simulate a response clipped at PostgREST's 1000-row cap: we can't tell
    // which feeds were dropped, so the whole call abandons the exact path.
    const capped = Array.from({ length: 1000 }, (_, i) => ({
      feed_id: 'feed-a',
      item_id: `x${i}`,
    }));
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) =>
      name === 'feed_unread_ids'
        ? Promise.resolve({ data: capped, error: null })
        : rpc(name, params)) as typeof env.fake.client.rpc;
    expect(await env.ds.getFeedUnreadIds(['feed-a'])).toBeNull();
  });

  it('getFeedUnreadIds: returns null against a backend that predates the RPC (PGRST202)', async () => {
    const env = setup();
    const rpc = env.fake.client.rpc.bind(env.fake.client);
    env.fake.client.rpc = ((name: string, params?: Record<string, unknown>) =>
      name === 'feed_unread_ids'
        ? Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'no function' } })
        : rpc(name, params)) as typeof env.fake.client.rpc;
    // Feature-detect → null, so the caller falls back to the count path (#11).
    expect(await env.ds.getFeedUnreadIds(['feed-a'])).toBeNull();
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
});
