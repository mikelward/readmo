// Runs in jsdom (the default; no node-environment pragma) because it exercises
// the window/document event wiring the SupabaseDataSource sets up to flush the
// outbox when the tab is backgrounded or closed — the "mark done then close the
// tab" durability path. The sibling SupabaseDataSource.test.ts runs in the node
// environment and can't see those events (no window), so this lives on its own.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseDataSource } from './SupabaseDataSource';
import { makeFakeSupabase, type FakeTables } from './fakeSupabaseClient';
import { _resetNetworkStatusForTests } from '../networkStatus';

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
}

const tick = () => new Promise((r) => setTimeout(r));

function emptySeed(): FakeTables {
  return {
    feeds_public: [],
    subscriptions: [],
    items: [],
    item_state: [],
    folders: [],
  };
}

let counter = 0;
function setup() {
  const fake = makeFakeSupabase(emptySeed());
  const ds = new SupabaseDataSource(
    `readmo:item-state:tabflush:${counter++}`,
    fake.client as unknown as SupabaseClient,
  );
  const stateWrites = () =>
    fake.rpcCalls.filter((c) => c.name === 'set_item_state');
  return { ds, fake, stateWrites };
}

describe('SupabaseDataSource tab-teardown flush', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetNetworkStatusForTests();
    setOnline(true);
    setHidden(false);
  });
  afterEach(() => {
    setOnline(true);
    setHidden(false);
    _resetNetworkStatusForTests();
  });

  it('pushes a queued triage write out when the tab is hidden', async () => {
    // Toggle offline so the enqueue's own flush no-ops and the write stays
    // queued — isolating the visibilitychange flush from the enqueue flush.
    setOnline(false);
    const { ds, stateWrites } = setup();

    ds.stateStore.set('i1', 'done', true, 1000);
    await tick();
    expect(stateWrites()).toHaveLength(0); // offline: nothing sent yet

    // Back online but with no `online` event dispatched — the tab going hidden
    // is what must push the queued write to the server.
    setOnline(true);
    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();

    expect(stateWrites()).toHaveLength(1);
    expect(stateWrites()[0].params).toMatchObject({ p_item_id: 'i1', p_done: true });
  });

  it('does not flush when visibility changes to visible (only on hidden)', async () => {
    setOnline(false);
    const { ds, stateWrites } = setup();
    ds.stateStore.set('i1', 'done', true, 1000);
    await tick();

    setOnline(true);
    setHidden(false); // a visibilitychange back to visible is the resync path, not this
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(stateWrites()).toHaveLength(0);
  });

  it('pushes a queued triage write out on pagehide', async () => {
    setOnline(false);
    const { ds, stateWrites } = setup();
    ds.stateStore.set('i1', 'hidden', true, 1000);
    await tick();
    expect(stateWrites()).toHaveLength(0);

    setOnline(true);
    window.dispatchEvent(new Event('pagehide'));
    await tick();
    expect(stateWrites()).toHaveLength(1);
  });
});
