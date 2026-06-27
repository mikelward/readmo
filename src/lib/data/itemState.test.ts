// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_ITEM_STATE, TTL_MS, type ItemState } from '../types';
import {
  ItemStateStore,
  applyMutation,
  withRetention,
  type StatePersistence,
} from './itemState';

const NOW = 1_700_000_000_000;

function state(partial: Partial<ItemState>): ItemState {
  return { ...DEFAULT_ITEM_STATE, ...partial };
}

describe('applyMutation', () => {
  it('sets a field and stamps its timestamp', () => {
    const next = applyMutation(DEFAULT_ITEM_STATE, 'favorite', true, NOW);
    expect(next.favorite).toBe(true);
    expect(next.favoriteAt).toBe(NOW);
    expect(next.version).toBe(1);
  });

  it('clears the timestamp when a field is turned off', () => {
    const prev = applyMutation(DEFAULT_ITEM_STATE, 'pinned', true, NOW);
    const next = applyMutation(prev, 'pinned', false, NOW + 1);
    expect(next.pinned).toBe(false);
    expect(next.pinnedAt).toBeNull();
  });

  it('pinning clears Done and Hidden (exclusivity)', () => {
    const prev = state({ done: true, doneAt: NOW, hidden: true, hiddenAt: NOW });
    const next = applyMutation(prev, 'pinned', true, NOW);
    expect(next.pinned).toBe(true);
    expect(next.done).toBe(false);
    expect(next.hidden).toBe(false);
  });

  it('hiding clears Pinned', () => {
    const prev = state({ pinned: true, pinnedAt: NOW });
    const next = applyMutation(prev, 'hidden', true, NOW);
    expect(next.hidden).toBe(true);
    expect(next.pinned).toBe(false);
  });

  it('marking Done clears Pinned', () => {
    const prev = state({ pinned: true, pinnedAt: NOW });
    const next = applyMutation(prev, 'done', true, NOW);
    expect(next.done).toBe(true);
    expect(next.pinned).toBe(false);
  });

  it('favorite and opened are independent of the others', () => {
    let s = applyMutation(DEFAULT_ITEM_STATE, 'pinned', true, NOW);
    s = applyMutation(s, 'favorite', true, NOW);
    s = applyMutation(s, 'opened', true, NOW);
    expect(s.pinned).toBe(true);
    expect(s.favorite).toBe(true);
    expect(s.opened).toBe(true);
  });

  it('does not mutate the input', () => {
    const prev = state({ pinned: true, pinnedAt: NOW });
    const copy = { ...prev };
    applyMutation(prev, 'done', true, NOW);
    expect(prev).toEqual(copy);
  });
});

describe('withRetention', () => {
  it('expires Hidden after the retention window', () => {
    const s = state({ hidden: true, hiddenAt: NOW });
    expect(withRetention(s, NOW + TTL_MS + 1).hidden).toBe(false);
    expect(withRetention(s, NOW + TTL_MS - 1).hidden).toBe(true);
  });

  it('expires Opened after the retention window', () => {
    const s = state({ opened: true, openedAt: NOW });
    expect(withRetention(s, NOW + TTL_MS + 1).opened).toBe(false);
    expect(withRetention(s, NOW + TTL_MS - 1).opened).toBe(true);
  });

  it('expires Done after the retention window (30-day completion log)', () => {
    const s = state({ done: true, doneAt: NOW });
    expect(withRetention(s, NOW + TTL_MS + 1).done).toBe(false);
    expect(withRetention(s, NOW + TTL_MS - 1).done).toBe(true);
  });

  it('never expires Pinned or Favorite', () => {
    const s = state({
      pinned: true,
      pinnedAt: NOW,
      favorite: true,
      favoriteAt: NOW,
    });
    const out = withRetention(s, NOW + 10 * TTL_MS);
    expect(out.pinned).toBe(true);
    expect(out.favorite).toBe(true);
  });
});

describe('ItemStateStore', () => {
  function memoryPersistence(): StatePersistence {
    let saved: Record<string, ItemState> = {};
    return {
      load: () => saved,
      save: (m) => {
        saved = m;
      },
    };
  }

  it('persists and notifies subscribers on mutation', () => {
    const store = new ItemStateStore(memoryPersistence());
    let notified = 0;
    store.subscribe(() => notified++);
    store.set('item-1', 'pinned', true);
    expect(store.get('item-1').pinned).toBe(true);
    expect(notified).toBe(1);
  });

  it('returns the default state for unknown ids', () => {
    const store = new ItemStateStore(memoryPersistence());
    expect(store.get('nope')).toEqual(DEFAULT_ITEM_STATE);
  });

  it('subscribeMutations fires the changed-field diff on user mutations only', () => {
    const store = new ItemStateStore(memoryPersistence());
    const events: Array<[string, Record<string, boolean>]> = [];
    store.subscribeMutations((id, changed) => events.push([id, changed]));

    store.set('a', 'pinned', true, NOW);
    expect(events).toEqual([['a', { pinned: true }]]);

    // Unpinning emits pinned:false.
    store.set('a', 'pinned', false, NOW);
    expect(events[1]).toEqual(['a', { pinned: false }]);

    // Hydration (cold/slow path, cross-device sync) reconciles server rows but
    // must NOT look like a user mutation — otherwise a background server pin
    // would be mistaken for one the reader just made.
    store.hydrate([['b', state({ pinned: true, pinnedAt: NOW, version: 1 })]], new Map(), NOW);
    expect(events).toHaveLength(2); // unchanged — no mutation event for hydrate
  });

  it('confirmServerVersion normalizes a settled row to the server version, persisted and silent', () => {
    const p = memoryPersistence();
    const store = new ItemStateStore(p);
    let notified = 0;
    // Two local edits coalesce into a single server write: the optimistic
    // version bumps twice, but the server row only increments once.
    store.set('a', 'pinned', true); // optimistic version 1
    store.set('a', 'pinned', false); // optimistic version 2
    expect(store.get('a').version).toBe(2);
    store.subscribe(() => notified++);
    store.confirmServerVersion('a', 1); // server only reached version 1
    expect(store.get('a').version).toBe(1);
    expect(store.get('a').pinned).toBe(false); // fields untouched
    expect(notified).toBe(0); // no field changed → no emit
    // Persisted, so the next boot seeds the real server version, not the
    // inflated optimistic one.
    expect(new ItemStateStore(p).get('a').version).toBe(1);
  });

  it('hidden→Done migration (constructor) preserves the server version, not applyMutation’s +1', () => {
    // A legacy hidden row persisted at version 4. The constructor migrates it to
    // Done so it surfaces in /done, but that is a local representation change —
    // it never wrote the server, so the version must stay 4. Bumping it would
    // seed an inflated optimistic-concurrency base on the next boot (the live
    // hydrate's real version-4 row can't pull it back down via the monotonic
    // merge), 40001-conflicting the next edit.
    // The constructor migration uses real Date.now(), so the hidden timestamp
    // must be recent (un-expired) for it to fire.
    const now = Date.now();
    let saved: Record<string, ItemState> = {
      a: state({ hidden: true, hiddenAt: now, version: 4 }),
    };
    const store = new ItemStateStore({
      load: () => saved,
      save: (m) => {
        saved = m;
      },
    });
    const a = store.get('a', now);
    expect(a.done).toBe(true);
    expect(a.hidden).toBe(false);
    expect(a.version).toBe(4); // preserved, not 5
  });

  it('hidden→Done migration (hydrate) preserves the server version, not applyMutation’s +1', () => {
    const store = new ItemStateStore(memoryPersistence());
    // Server returns a legacy hidden row at version 7; hydrate migrates it to
    // Done locally but must keep the server's version so seeding stays honest.
    store.hydrate([['a', state({ hidden: true, hiddenAt: NOW, version: 7 })]], new Map(), NOW);
    const a = store.get('a', NOW);
    expect(a.done).toBe(true);
    expect(a.hidden).toBe(false);
    expect(a.version).toBe(7); // preserved, not 8
  });

  it('confirmServerVersion no-ops for an unknown or already-matching row', () => {
    const store = new ItemStateStore(memoryPersistence());
    store.confirmServerVersion('missing', 5); // no row → no create, no throw
    expect(store.get('missing')).toEqual(DEFAULT_ITEM_STATE);
    store.set('a', 'done', true); // version 1
    let notified = 0;
    store.subscribe(() => notified++);
    store.confirmServerVersion('a', 1); // already at 1
    expect(store.get('a').version).toBe(1);
    expect(notified).toBe(0);
  });

  it('write-through sink fires the changed-field diff (set / hide / undo), not on hydrate', () => {
    const store = new ItemStateStore(memoryPersistence());
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));

    store.set('a', 'pinned', true);
    store.hide('b'); // done = true (undoable)
    store.undoLast(); // reverts b -> done false
    // Hydration overlays server rows and must NOT write back through the sink.
    store.hydrate([['c', { ...DEFAULT_ITEM_STATE, done: true, version: 5 }]]);

    expect(calls).toEqual([
      ['a', { pinned: true }],
      ['b', { done: true }],
      ['b', { done: false }],
    ]);
  });

  it('undo write-through restores (only) a pin that dismissing cleared', () => {
    const store = new ItemStateStore(memoryPersistence());
    store.set('x', 'pinned', true); // pinned
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));
    store.hide('x'); // done clears pinned -> diff { done:true, pinned:false }
    store.undoLast(); // restores -> diff { done:false, pinned:true }

    expect(calls).toEqual([
      ['x', { pinned: false, done: true }],
      ['x', { pinned: true, done: false }],
    ]);
  });

  it('write-through omits independent fields not touched by the action', () => {
    const store = new ItemStateStore(memoryPersistence());
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));
    store.set('y', 'favorite', true);
    // Favoriting must not send pinned/done/hidden/opened (no stale clobber).
    expect(calls).toEqual([['y', { favorite: true }]]);
  });

  it('applies retention on read', () => {
    const store = new ItemStateStore(memoryPersistence());
    store.set('item-1', 'hidden', true, NOW);
    expect(store.get('item-1', NOW + TTL_MS + 1).hidden).toBe(false);
  });

  it('re-dismissing an item whose Done expired re-stamps and emits the sink', () => {
    const store = new ItemStateStore(memoryPersistence());
    store.set('z', 'done', true, NOW); // a Done row that will age out
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));

    const later = NOW + TTL_MS + 1; // Done has expired; UI shows it as not-done
    expect(store.get('z', later).done).toBe(false);

    // Re-dismissing must register as a real transition (not a no-op diff against
    // the still-raw `done:true`), so the sink fires and the timestamp re-stamps.
    store.set('z', 'done', true, later);
    expect(calls).toEqual([['z', { done: true }]]);
    expect(store.get('z', later).done).toBe(true); // no longer expired
  });

  it('undo after re-dismissing an expired Done reverts the sink write too', () => {
    const store = new ItemStateStore(memoryPersistence());
    store.set('z', 'done', true, NOW); // stale Done
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));

    const later = NOW + TTL_MS + 1;
    store.hideMany(['z'], later); // re-dismiss the (effectively not-done) item
    store.undoLast();

    // Dismiss sends done:true; Undo must send done:false so the server doesn't
    // keep it dismissed after the next hydrate.
    expect(calls).toEqual([
      ['z', { done: true }],
      ['z', { done: false }],
    ]);
    expect(store.get('z', later).done).toBe(false);
  });

  describe('hideMany undo batching', () => {
    // Read state back at NOW (the mutation time) so the 30-day Done retention
    // doesn't collapse the flag — these assert batching, not retention.
    it('replaces the undo batch by default (one Undo restores the last call only)', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.hideMany(['a'], NOW);
      store.hideMany(['b'], NOW); // keyless → new batch
      store.undoLast();
      expect(store.get('a', NOW).done).toBe(true); // a stays hidden
      expect(store.get('b', NOW).done).toBe(false); // only the last batch restored
    });

    it('accumulates same-key dismissals so one Undo restores the whole burst', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.hideMany(['a'], NOW, { batchKey: 1 });
      store.hideMany(['b'], NOW, { batchKey: 1 });
      store.hideMany(['c'], NOW, { batchKey: 1 });
      expect(store.get('a', NOW).done).toBe(true);
      expect(store.get('b', NOW).done).toBe(true);
      expect(store.get('c', NOW).done).toBe(true);

      store.undoLast();
      expect(store.get('a', NOW).done).toBe(false);
      expect(store.get('b', NOW).done).toBe(false);
      expect(store.get('c', NOW).done).toBe(false);
    });

    it('starts a fresh batch when the key changes', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.hideMany(['a'], NOW, { batchKey: 1 });
      store.hideMany(['b'], NOW, { batchKey: 2 }); // new burst
      store.undoLast();
      expect(store.get('a', NOW).done).toBe(true); // earlier burst untouched
      expect(store.get('b', NOW).done).toBe(false);
    });

    it('does not bundle a keyless dismissal between two same-key scroll hides', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.hideMany(['a'], NOW, { batchKey: 1 }); // scroll hide
      store.hideMany(['m'], NOW); // manual swipe/Sweep (keyless) replaces the batch
      store.hideMany(['b'], NOW, { batchKey: 1 }); // later scroll hide — same key
      // The later scroll hide must NOT re-extend the manual batch; it starts a
      // fresh one, so Undo restores only 'b'.
      store.undoLast();
      expect(store.get('b', NOW).done).toBe(false);
      expect(store.get('a', NOW).done).toBe(true);
      expect(store.get('m', NOW).done).toBe(true);
    });

    it('preserves the original prior state when an id is re-delivered into the batch', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true, NOW); // a starts pinned
      store.hideMany(['a'], NOW, { batchKey: 1 }); // done clears the pin (prior = pinned)
      // Re-deliver the same id (e.g. observer recreation before the refetch
      // drops the row). It must not overwrite the prior snapshot with Done.
      store.hideMany(['a'], NOW, { batchKey: 1 });

      store.undoLast();
      expect(store.get('a', NOW).done).toBe(false);
      expect(store.get('a', NOW).pinned).toBe(true); // original pin restored, not lost
    });
  });

  it('returns a referentially-stable snapshot between mutations', () => {
    // useSyncExternalStore requires get() to return the same reference when
    // nothing changed — even for state past its TTL (withRetention clones).
    const store = new ItemStateStore(memoryPersistence());
    store.set('item-1', 'hidden', true, NOW);
    const later = NOW + TTL_MS + 1;
    const a = store.get('item-1', later);
    const b = store.get('item-1', later);
    expect(a).toBe(b); // same object identity, no re-render churn
    expect(a.hidden).toBe(false); // and retention is applied

    // A real mutation produces a new snapshot.
    store.set('item-1', 'pinned', true, later);
    expect(store.get('item-1', later)).not.toBe(a);
  });

  it('recomputes the cached snapshot after the TTL boundary', () => {
    const store = new ItemStateStore(memoryPersistence());
    store.set('item-1', 'hidden', true, NOW);
    // Read before expiry: stable and still hidden.
    const before1 = store.get('item-1', NOW + 1000);
    const before2 = store.get('item-1', NOW + 2000);
    expect(before1).toBe(before2);
    expect(before1.hidden).toBe(true);
    // Read past the TTL boundary (same raw, no mutation): now expired, so the
    // cache must recompute rather than return the stale hidden snapshot.
    const after = store.get('item-1', NOW + TTL_MS + 1);
    expect(after.hidden).toBe(false);
  });

  describe('hydrate (server reconcile)', () => {
    const srv = (over: Partial<ItemState>): ItemState => ({
      ...DEFAULT_ITEM_STATE,
      ...over,
    });

    it('takes server truth for non-pending items', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true);
      // Server says a is done (not pinned); a has no pending write → server wins.
      store.hydrate([['a', srv({ done: true, version: 9 })]], new Map());
      expect(store.get('a').pinned).toBe(false);
      expect(store.get('a').done).toBe(true);
    });

    it('drops local-only rows the server omits when not pending', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true);
      store.hydrate([], new Map()); // server has no rows, nothing pending
      expect(store.get('a')).toEqual(DEFAULT_ITEM_STATE); // cleared
    });

    it('preserves a pending local row the server has not yet got', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true); // optimistic, still in flight
      // a is pending → keep the optimistic pin.
      store.hydrate([], new Map([['a', { pinned: true }]]));
      expect(store.get('a').pinned).toBe(true);
    });

    it('keeps the optimistic value for a pending item the server also returns', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true);
      // Server still shows the pre-write (unpinned) row, but a is pending.
      store.hydrate(
        [['a', srv({ pinned: false, version: 2 })]],
        new Map([['a', { pinned: true }]]),
      );
      expect(store.get('a').pinned).toBe(true);
    });

    it('adopts an independent server field while keeping the pending one', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true); // local pending write: pinned
      // Server hasn't got the pin yet, but another device favorited a.
      store.hydrate(
        [['a', srv({ pinned: false, favorite: true, version: 3 })]],
        new Map([['a', { pinned: true }]]),
      );
      expect(store.get('a').pinned).toBe(true); // pending field preserved
      expect(store.get('a').favorite).toBe(true); // independent server field adopted
    });
  });
});
