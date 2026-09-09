// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseDataSource } from './SupabaseDataSource';
import { makeFakeSupabase, type FakeTables } from './fakeSupabaseClient';
import { _resetNetworkStatusForTests } from '../networkStatus';

// Cold-boot outbox replay needs real localStorage (the persisted outbox), so
// this runs in jsdom rather than the node env the rest of the suite uses.

const STATE_KEY = 'readmo:item-state:coldboot';

function emptyTables(): FakeTables {
  return { feeds_public: [], subscriptions: [], items: [], item_state: [], folders: [] };
}

/** Mirrors the data source's keyset hydrate chain (select → order → limit →
 * [gt] → not, then awaited); `resolve` supplies the awaited result. */
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

describe('SupabaseDataSource cold-boot outbox replay', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetNetworkStatusForTests();
  });
  afterEach(() => {
    window.localStorage.clear();
    _resetNetworkStatusForTests();
  });

  it('drops a persisted pre-LWW (base-version) outbox entry at boot instead of replaying or retrying it', async () => {
    // A pre-0023 client persisted boolean changed-fields with a base version —
    // no per-field `at`. Replaying that against the LWW set_item_state would
    // throw in the send serializer (`new Date(undefined).toISOString()`), which
    // the drain classifies as TRANSIENT — so the entry would retry on backoff
    // forever and pin its item in pendingIds() (the hydrate overlay). The LWW
    // cutover discards old persisted state (0023 + the userCache `:v2` key
    // bump); the outbox's load-time sanitization is the backstop for any such
    // entry that still surfaces under a current key: drop it, don't wedge on it.
    window.localStorage.setItem(
      `${STATE_KEY}:outbox`,
      JSON.stringify([{ id: 'i6', changed: { pinned: true }, base: null }]),
    );

    const fake = makeFakeSupabase(emptyTables());
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = ((table: string) => {
      if (table !== 'item_state') return realFrom(table);
      // Boot read held open → the hydration stays in flight.
      return itemStateReadStub(() => new Promise(() => {})) as ReturnType<typeof realFrom>;
    }) as typeof fake.client.from;

    let setItemStateCalls = 0;
    const realRpc = fake.client.rpc.bind(fake.client);
    fake.client.rpc = ((name: string, params?: Record<string, unknown>) => {
      if (name === 'set_item_state') setItemStateCalls += 1;
      return realRpc(name, params);
    }) as typeof fake.client.rpc;

    const ds = new SupabaseDataSource(
      STATE_KEY,
      fake.client as unknown as SupabaseClient,
    );
    // The malformed write is dropped at load: nothing goes out, nothing stays
    // queued (the boot flush persists the now-empty outbox), and the item is
    // not pinned in the pending set forever.
    await new Promise((r) => setTimeout(r));
    await new Promise((r) => setTimeout(r));
    expect(setItemStateCalls).toBe(0);
    expect(window.localStorage.getItem(`${STATE_KEY}:outbox`)).toBeNull();
    expect([...ds.pendingItemIds()]).toEqual([]);
  });
});
