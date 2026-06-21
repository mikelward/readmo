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
});
