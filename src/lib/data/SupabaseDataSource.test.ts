// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseDataSource } from './SupabaseDataSource';
import { _resetNetworkStatusForTests, setConnectivityProbeUrl } from '../networkStatus';
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
    // 3 rows < the default limit (30), so the page is short → no next cursor.
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
        return {
          select: () => ({ not: () => bootRead }),
        } as unknown as ReturnType<typeof realFrom>;
      }
      // Resync read: resolves immediately with the updated snapshot.
      return {
        select: () => ({ not: () => Promise.resolve(settle) }),
      } as unknown as ReturnType<typeof realFrom>;
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
      return {
        select: () => ({
          not: () =>
            Promise.resolve({ data: null, count: null, error: { message: 'offline' } }),
        }),
      } as unknown as ReturnType<typeof realFrom>;
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
      return {
        select: () => ({ not: () => Promise.resolve({ data: [], count: null, error: null }) }),
      } as unknown as ReturnType<typeof realFrom>;
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
        return { select: () => ({ not: () => p }) } as unknown as ReturnType<typeof realFrom>;
      }
      // The retry read: signal that a fresh resync ran, then succeed.
      retryStarted();
      return {
        select: () => ({ not: () => Promise.resolve({ data: [], count: null, error: null }) }),
      } as unknown as ReturnType<typeof realFrom>;
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
      return {
        select: () => ({
          not: () =>
            Promise.resolve({ data: null, count: null, error: { message: 'offline' } }),
        }),
      } as unknown as ReturnType<typeof realFrom>;
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

  it('normalizes the optimistic store version to the server version after a coalesced write', async () => {
    // Drift scenario: two local edits made offline COALESCE into a single server
    // write. The store's optimistic version bumps once per edit (twice here), but
    // the single server write increments the row once. Left unreconciled, a later
    // cold-boot `seedConfirmedVersions` would base an offline edit on the inflated
    // version and the RPC would 40001-reject it, dropping a change no other device
    // touched. A successful write must normalize the store to the server version.
    const fake = makeFakeSupabase(seed());
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let online = false; // gate the OUTBOX (reads ignore navigator)
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        get onLine() {
          return online;
        },
      },
      configurable: true,
    });
    try {
      const ds = new SupabaseDataSource(
        'readmo:item-state:test',
        fake.client as unknown as SupabaseClient,
      );
      await ds.getItemsByIds([]); // boot hydrate (reads work; outbox is offline)

      // Two coalesced offline edits → optimistic version 2, one queued write.
      ds.stateStore.set('i3', 'pinned', true);
      ds.stateStore.set('i3', 'pinned', false);
      expect(ds.stateStore.get('i3').version).toBe(2);

      // Hold the resync's item_state READ open so only the WRITE's
      // confirmServerVersion — not a follow-up hydrate (which would also rewrite
      // the version to server truth and mask the fix) — can touch the version.
      const realFrom = fake.client.from.bind(fake.client);
      let releaseRead!: () => void;
      const readGate = new Promise<void>((r) => (releaseRead = r));
      fake.client.from = ((table: string) => {
        if (table !== 'item_state') return realFrom(table);
        return {
          select: () => ({ not: () => readGate.then(() => ({ data: [], count: null, error: null })) }),
        } as unknown as ReturnType<typeof realFrom>;
      }) as typeof fake.client.from;

      // Back online; the coalesced write flushes. Await the post-commit emit
      // (onDrained → notifySynced) so the assertion waits on the real write, not a
      // timer. confirmServerVersion runs inside the send, before that emit.
      const committed = new Promise<void>((resolve) => {
        const unsub = ds.stateStore.subscribe(() => {
          unsub();
          resolve();
        });
      });
      online = true;
      void ds.resyncState(); // kicks outbox.flush(); the hydration read stays gated
      await committed;

      // Server applied ONE write → version 1. The store is normalized to it, not
      // left at the inflated optimistic 2.
      expect(ds.stateStore.get('i3').version).toBe(1);
      expect(ds.stateStore.get('i3').pinned).toBe(false);

      releaseRead();
    } finally {
      if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
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

  it('windows each feed section to perFeedLimit and returns one page (group by feed)', async () => {
    const env = setup();
    // Cap each section to 1 row. feed-a (i2 pinned, then i6) → just i2;
    // feed-b (i3) → i3. The clipped i6 is reachable via the per-section More.
    const page = await env.ds.getHomeItems({ groupByFeed: true, perFeedLimit: 1 });
    expect(ids(page.items)).toEqual(['i2', 'i3']);
    // The windowed grouped read is a single page (no global next cursor).
    expect(page.nextCursor).toBeNull();
    // The cap was threaded to the RPC.
    const call = env.fake.rpcCalls.find((c) => c.name === 'feed_items');
    expect(call?.params).toMatchObject({ p_group_by_feed: true, p_per_feed_limit: 1 });

    // The per-section More re-reads that one feed past the window (offset 1).
    const more = await env.ds.getFeedItems('feed-a', { cursor: '1', limit: 1 });
    expect(ids(more.items)).toEqual(['i6']);
  });

  it('windows each feed independently even when two subscriptions share a sort ordinal', async () => {
    // The per-feed cap must partition by feed id, not the subscription sort
    // ordinal — otherwise two feeds sharing a sort value would be ranked as one
    // window and the first could starve the second out of the opening read.
    const tables = seed();
    tables.subscriptions = tables.subscriptions.map((s) =>
      s.feed_id === 'feed-b' ? { ...s, sort: 0 } : s,
    );
    const { ds } = setup(tables);
    const page = await ds.getHomeItems({ groupByFeed: true, perFeedLimit: 1 });
    const feeds = new Set(page.items.map((fi) => fi.item.feedId));
    // Each feed keeps its own 1-row window; neither is starved by the other.
    expect(feeds.has('feed-a')).toBe(true);
    expect(feeds.has('feed-b')).toBe(true);
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

  it('pages windowed grouped reads past the row cap (offset threaded, not forced to 0)', async () => {
    const env = setup();
    // A cursor on a windowed grouped read continues from that offset so the next
    // batch of feed-sections isn't dropped when an account overflows the row cap.
    await env.ds.getHomeItems({ groupByFeed: true, perFeedLimit: 1, cursor: '1000' });
    const call = env.fake.rpcCalls.find((c) => c.name === 'feed_items');
    expect(call?.params).toMatchObject({ p_offset: 1000, p_per_feed_limit: 1 });
  });

  it('omits the p_per_feed_limit arg entirely on flat/single-feed reads (forward-compatible payload)', async () => {
    // Sending the 8th arg only for the windowed grouped read keeps flat/folder/
    // single-feed reads on the 7-arg payload, so a client deployed before
    // migration 0021 still resolves them against the old 7-arg function
    // (PostgREST 404s a call carrying an unknown parameter name).
    const env = setup();
    await env.ds.getHomeItems(); // flat
    await env.ds.getFeedItems('feed-a'); // single feed
    const calls = env.fake.rpcCalls.filter((c) => c.name === 'feed_items');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect('p_per_feed_limit' in c.params).toBe(false);
    }
    // The grouped windowed read does carry it.
    await env.ds.getHomeItems({ groupByFeed: true, perFeedLimit: 5 });
    const grouped = env.fake.rpcCalls.filter((c) => c.name === 'feed_items').at(-1);
    expect(grouped?.params).toMatchObject({ p_per_feed_limit: 5 });
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
