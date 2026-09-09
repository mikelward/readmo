// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseDataSource } from './SupabaseDataSource';
import { makeFakeSupabase, type FakeTables } from './fakeSupabaseClient';
import { _resetNetworkStatusForTests } from '../networkStatus';
import type { ItemState } from '../types';

// The boot pinned-first read only runs on a WARM boot — one that restored
// last-good state — so these need real localStorage and run in jsdom rather than
// the node env most of the data-source suite uses.

const STATE_KEY = 'readmo:item-state:pinnedprime';
const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
const recentMs = Date.parse(recent);

function tables(itemState: Array<Record<string, unknown>> = []): FakeTables {
  return {
    feeds_public: [],
    subscriptions: [],
    items: [],
    item_state: itemState,
    folders: [],
  };
}

function mkState(item_id: string, over: Record<string, unknown>) {
  return {
    user_id: 'u1',
    item_id,
    pinned: false,
    pinned_at: null,
    favorite: false,
    favorite_at: null,
    done: false,
    done_at: null,
    hidden: false,
    hidden_at: null,
    opened: false,
    opened_at: null,
    updated_at: recent,
    ...over,
  };
}

function mkLocal(over: Partial<ItemState> = {}): ItemState {
  return {
    pinned: false,
    pinnedAt: null,
    favorite: false,
    favoriteAt: null,
    done: false,
    doneAt: null,
    hidden: false,
    hiddenAt: null,
    opened: false,
    openedAt: null,
    ...over,
  };
}

/** Seed a warm boot: last-good state already in localStorage under STATE_KEY. */
function seedLocal(map: Record<string, ItemState>): void {
  window.localStorage.setItem(STATE_KEY, JSON.stringify(map));
}

/** Record every `item_state` select, tagging the boot pinned prime — the only
 * one that filters with `.eq` — so a test can tell it from the hydration reads
 * and count round trips before each lands. */
function trackItemStateReads(fake: ReturnType<typeof makeFakeSupabase>) {
  const reads: Array<{ cols?: string; prime: boolean; settled: boolean }> = [];
  const realFrom = fake.client.from.bind(fake.client);
  fake.client.from = ((table: string) => {
    const q = realFrom(table);
    if (table !== 'item_state') return q;
    const read = { cols: undefined as string | undefined, prime: false, settled: false };
    const realSelect = q.select.bind(q);
    const realEq = q.eq.bind(q);
    const realThen = q.then.bind(q);
    q.select = ((c?: string, o?: { count?: string }) => {
      read.cols = c;
      reads.push(read);
      return realSelect(c, o);
    }) as typeof q.select;
    q.eq = ((c: string, v: unknown) => {
      if (c === 'pinned') read.prime = true;
      return realEq(c, v);
    }) as typeof q.eq;
    q.then = ((onF?: never, onR?: never) =>
      realThen(
        (v) => {
          read.settled = true;
          return (onF as ((x: unknown) => unknown) | undefined)?.(v) ?? v;
        },
        onR,
      )) as typeof q.then;
    return q;
  }) as typeof fake.client.from;
  return {
    all: () => reads,
    primes: () => reads.filter((r) => r.prime),
    hydrations: () => reads.filter((r) => !r.prime),
  };
}

/** Resolve once the store reports `predicate`, driven by its own change events
 * rather than a timer — so the wait ends exactly when the read lands. */
function whenStore(
  ds: SupabaseDataSource,
  predicate: () => boolean,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = ds.stateStore.subscribe(() => {
      if (!predicate()) return;
      unsubscribe();
      resolve();
    });
  });
}

describe('SupabaseDataSource boot pinned-first item_state read', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetNetworkStatusForTests();
  });
  afterEach(() => {
    window.localStorage.clear();
    _resetNetworkStatusForTests();
  });

  it('adopts another device’s pin from its own read, before the full hydration lands', async () => {
    // The reported symptom: open the app on a second device and a pin made
    // elsewhere takes seconds to show, because nothing tells this client about
    // it until the whole cold-boot full read (high-water probe + keyset pages)
    // has landed. The pinned prime is what closes that gap.
    seedLocal({ i1: mkLocal({ opened: true, openedAt: recentMs }) });
    const fake = makeFakeSupabase(
      tables([
        mkState('i1', { opened: true, opened_at: recent }),
        mkState('i2', { pinned: true, pinned_at: recent }),
      ]),
    );
    const track = trackItemStateReads(fake);
    // Hold every read that names the cursor column — the probe and the full
    // read's pages — open, so the ONLY thing that can land is the prime.
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = ((table: string) => {
      const q = realFrom(table);
      if (table !== 'item_state') return q;
      const realSelect = q.select.bind(q);
      q.select = ((c?: string, o?: { count?: string }) => {
        const built = realSelect(c, o);
        if (c?.includes('updated_at')) {
          return new Proxy(built, {
            get: (t, prop) =>
              prop === 'then' ? () => new Promise(() => {}) : Reflect.get(t, prop),
          });
        }
        return built;
      }) as typeof q.select;
      return q;
    }) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      STATE_KEY,
      fake.client as unknown as SupabaseClient,
    );
    await whenStore(ds, () => ds.stateStore.get('i2').pinned);

    // The pin landed off the prime alone: no cursor-bearing read has settled.
    expect(ds.stateStore.get('i2').pinned).toBe(true);
    expect(track.hydrations().every((r) => !r.settled)).toBe(true);
    // And it cost exactly one request — the point of the whole exercise.
    expect(track.primes()).toHaveLength(1);
  });

  it('is additive: an un-pinned local row it does not mention is left alone', async () => {
    // The prime reads only the pinned slice, so almost every local row is
    // absent from its response. Applied as a PARTIAL hydrate, absent means
    // "not in this slice" and never "deleted server-side" — the drop pass stays
    // the full read's job. Getting this wrong would wipe the library on boot.
    seedLocal({
      i1: mkLocal({ done: true, doneAt: recentMs }),
      i3: mkLocal({ favorite: true, favoriteAt: recentMs }),
    });
    const fake = makeFakeSupabase(tables([mkState('i2', { pinned: true, pinned_at: recent })]));
    const ds = new SupabaseDataSource(
      STATE_KEY,
      fake.client as unknown as SupabaseClient,
    );
    await whenStore(ds, () => ds.stateStore.get('i2').pinned);

    expect(ds.stateStore.get('i1').done).toBe(true);
    expect(ds.stateStore.get('i3').favorite).toBe(true);
  });

  it('does not advance the cursor, so the boot read still runs FULL', async () => {
    // The prime's projection carries no `updated_at` and it speaks only for the
    // pinned slice. Were it to seed the cursor, the boot read would go
    // incremental and skip the drop pass that re-establishes "absent = stale".
    seedLocal({ i1: mkLocal({ opened: true, openedAt: recentMs }) });
    const fake = makeFakeSupabase(tables([mkState('i2', { pinned: true, pinned_at: recent })]));
    const track = trackItemStateReads(fake);
    const ds = new SupabaseDataSource(
      STATE_KEY,
      fake.client as unknown as SupabaseClient,
    );
    await ds.resyncState();

    // A full read is the bare-cursor high-water probe plus its page(s). Its
    // presence proves the boot read did not take the incremental branch.
    expect(track.hydrations()[0]?.cols).toBe('updated_at');
  });

  it('runs once per session, not on every later resync', async () => {
    // Every hydration after boot is either incremental or the authoritative
    // full read; re-reading the pinned slice ahead of one would just spend a
    // request.
    seedLocal({ i1: mkLocal({ opened: true, openedAt: recentMs }) });
    const fake = makeFakeSupabase(tables([mkState('i2', { pinned: true, pinned_at: recent })]));
    const track = trackItemStateReads(fake);
    const ds = new SupabaseDataSource(
      STATE_KEY,
      fake.client as unknown as SupabaseClient,
    );
    await ds.resyncState();
    await ds.resyncState();
    await ds.resyncState();

    expect(track.primes()).toHaveLength(1);
  });

  it('is skipped entirely on a boot with no last-good state', async () => {
    // A brand-new or cache-purged device has no gap to close — every flag
    // arrives with the full read regardless — and priming an empty store would
    // make it read as "last-good state available", cutting short the bounded
    // cold-hydration wait that keeps the first paint off default flags.
    const fake = makeFakeSupabase(tables([mkState('i2', { pinned: true, pinned_at: recent })]));
    const track = trackItemStateReads(fake);
    const ds = new SupabaseDataSource(
      STATE_KEY,
      fake.client as unknown as SupabaseClient,
    );
    await ds.resyncState();

    expect(track.primes()).toHaveLength(0);
    // The full read still populates the store, so nothing is lost by skipping.
    expect(ds.stateStore.get('i2').pinned).toBe(true);
  });

  it('keeps an un-synced local unpin whose clock TIES the server row', async () => {
    // The reader unpinned on THIS device and the write is still queued, so the
    // server row the prime reads back is the pre-unpin one. Its `pinned_at`
    // ties the local clock to the millisecond — the case per-field LWW cannot
    // decide on its own (it resolves a tie to the server value), so only the
    // pending overlay keeps the unpin. Without it the prime would re-pin what
    // the reader just unpinned. A tie is the whole point: give the local write
    // a newer clock and LWW alone would pass this, testing nothing.
    const tie = Date.parse(recent);
    seedLocal({ i2: mkLocal({ pinned: false, pinnedAt: tie }) });
    window.localStorage.setItem(
      `${STATE_KEY}:outbox`,
      JSON.stringify([{ id: 'i2', changed: { pinned: { value: false, at: tie } } }]),
    );
    const fake = makeFakeSupabase(tables([mkState('i2', { pinned: true, pinned_at: recent })]));
    // Hold the write so the entry is still pending while the prime applies.
    const realRpc = fake.client.rpc.bind(fake.client);
    fake.client.rpc = ((name: string, params?: Record<string, unknown>) =>
      name === 'set_item_state'
        ? (new Promise(() => {}) as ReturnType<typeof realRpc>)
        : realRpc(name, params)) as typeof fake.client.rpc;

    const ds = new SupabaseDataSource(
      STATE_KEY,
      fake.client as unknown as SupabaseClient,
    );
    await ds.resyncState();

    expect(ds.stateStore.get('i2').pinned).toBe(false);
  });

  it('is non-fatal: a failed prime still leaves the full hydration to land the rows', async () => {
    seedLocal({ i1: mkLocal({ opened: true, openedAt: recentMs }) });
    const fake = makeFakeSupabase(tables([mkState('i2', { pinned: true, pinned_at: recent })]));
    // Scoped to the prime: it is the only item_state read that filters on
    // `pinned`, so this fails it without touching the hydration reads.
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = ((table: string) => {
      const q = realFrom(table);
      if (table !== 'item_state') return q;
      const realEq = q.eq.bind(q);
      q.eq = ((c: string, v: unknown) => {
        const built = realEq(c, v);
        if (c !== 'pinned') return built;
        return new Proxy(built, {
          get: (t, prop) =>
            prop === 'then'
              ? (onF: (x: unknown) => unknown) =>
                  Promise.resolve(
                    onF({ data: null, count: null, error: { message: 'boom' } }),
                  )
              : Reflect.get(t, prop),
        });
      }) as typeof q.eq;
      return q;
    }) as typeof fake.client.from;

    const ds = new SupabaseDataSource(
      STATE_KEY,
      fake.client as unknown as SupabaseClient,
    );
    await ds.resyncState();

    expect(ds.stateStore.get('i2').pinned).toBe(true);
  });
});
