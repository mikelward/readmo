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
  it('expires Hidden after 7 days', () => {
    const s = state({ hidden: true, hiddenAt: NOW });
    expect(withRetention(s, NOW + TTL_MS + 1).hidden).toBe(false);
    expect(withRetention(s, NOW + TTL_MS - 1).hidden).toBe(true);
  });

  it('expires Opened after 7 days', () => {
    const s = state({ opened: true, openedAt: NOW });
    expect(withRetention(s, NOW + TTL_MS + 1).opened).toBe(false);
  });

  it('never expires Pinned/Favorite/Done', () => {
    const s = state({
      pinned: true,
      pinnedAt: NOW,
      favorite: true,
      favoriteAt: NOW,
      done: true,
      doneAt: NOW,
    });
    const out = withRetention(s, NOW + 10 * TTL_MS);
    expect(out.pinned).toBe(true);
    expect(out.favorite).toBe(true);
    expect(out.done).toBe(true);
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

  it('write-through sink fires the changed-field diff (set / hide / undo), not on hydrate', () => {
    const store = new ItemStateStore(memoryPersistence());
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));

    store.set('a', 'pinned', true);
    store.hide('b'); // hidden = true (undoable)
    store.undoLast(); // reverts b -> hidden false
    // Hydration overlays server rows and must NOT write back through the sink.
    store.hydrate([['c', { ...DEFAULT_ITEM_STATE, done: true, version: 5 }]]);

    expect(calls).toEqual([
      ['a', { pinned: true }],
      ['b', { hidden: true }],
      ['b', { hidden: false }],
    ]);
  });

  it('undo write-through restores (only) a pin that hiding cleared', () => {
    const store = new ItemStateStore(memoryPersistence());
    store.set('x', 'pinned', true); // pinned
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));
    store.hide('x'); // hiding clears pinned -> diff { hidden:true, pinned:false }
    store.undoLast(); // restores -> diff { hidden:false, pinned:true }

    expect(calls).toEqual([
      ['x', { pinned: false, hidden: true }],
      ['x', { pinned: true, hidden: false }],
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
      store.hydrate([['a', srv({ done: true, version: 9 })]], []);
      expect(store.get('a').pinned).toBe(false);
      expect(store.get('a').done).toBe(true);
    });

    it('drops local-only rows the server omits when not pending', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true);
      store.hydrate([], []); // server has no rows for this user, nothing pending
      expect(store.get('a')).toEqual(DEFAULT_ITEM_STATE); // cleared
    });

    it('preserves a pending local row the server has not yet got', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true); // optimistic, still in flight
      store.hydrate([], ['a']); // a is pending → keep the optimistic pin
      expect(store.get('a').pinned).toBe(true);
    });

    it('keeps the optimistic value for a pending item the server also returns', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true);
      // Server still shows the pre-write (unpinned) row, but a is pending.
      store.hydrate([['a', srv({ pinned: false, version: 2 })]], ['a']);
      expect(store.get('a').pinned).toBe(true);
    });
  });
});
