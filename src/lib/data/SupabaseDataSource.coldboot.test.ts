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

  it('holds a persisted no-base write at boot until the hydrate lands (no unchecked replay across reload)', async () => {
    // A brand-new-row write made in a prior session persists with no base. On the
    // next boot it must NOT replay unchecked before the boot hydrate starts —
    // that would let a reload defeat the in-session hold and clobber a
    // cross-device change. The constructor kicks the hydrate (marking it in
    // flight) BEFORE the initial flush, so the no-base entry is held until the
    // hydrate resolves its base.
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
    // The persisted write is held, not replayed: no set_item_state went out, and
    // the entry is still queued (persisted), so it'll send with a real base once
    // the boot hydrate lands.
    void ds;
    await new Promise((r) => setTimeout(r));
    await new Promise((r) => setTimeout(r));
    expect(setItemStateCalls).toBe(0);
    const persisted = window.localStorage.getItem(`${STATE_KEY}:outbox`);
    expect(persisted).toContain('i6'); // still queued, not sent + cleared
  });
});
