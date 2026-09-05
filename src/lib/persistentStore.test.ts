import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistentStore } from './persistentStore';

const KEY = 'readmo:test:store';
const EVENT = 'readmo:test:store-changed';

type Obj = { kind: string };

function objStore() {
  return createPersistentStore<Obj>({
    storageKey: KEY,
    changeEvent: EVENT,
    defaultValue: { kind: 'default' },
    parse: (raw) => {
      try {
        const v = JSON.parse(raw) as Obj;
        return typeof v?.kind === 'string' ? v : undefined;
      } catch {
        return undefined;
      }
    },
    serialize: (v) => JSON.stringify(v),
  });
}

/** Same store, opted in to holding what storage refuses. */
function holdingStore(discardStaleOnRefusal = false) {
  return createPersistentStore<Obj>({
    storageKey: KEY,
    changeEvent: EVENT,
    defaultValue: { kind: 'default' },
    parse: (raw) => JSON.parse(raw) as Obj,
    serialize: (v) => JSON.stringify(v),
    holdRefusedWrite: true,
    discardStaleOnRefusal,
  });
}

function refuseWrites() {
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('createPersistentStore', () => {
  it('returns the (stable) default when unset, and falls back on corrupt/invalid', () => {
    const s = objStore();
    const d1 = s.get();
    expect(d1).toEqual({ kind: 'default' });
    expect(s.get()).toBe(d1); // same reference — won't loop useSyncExternalStore

    window.localStorage.setItem(KEY, '{bad json');
    expect(s.get()).toBe(d1); // invalid → default reference
    window.localStorage.setItem(KEY, JSON.stringify({ no: 'kind' }));
    expect(s.get()).toBe(d1); // shape-invalid → default
  });

  it('round-trips and keeps an Object.is-stable snapshot while the raw string is unchanged', () => {
    const s = objStore();
    s.set({ kind: 'folder' });
    expect(window.localStorage.getItem(KEY)).toBe('{"kind":"folder"}');
    const a = s.get();
    expect(a).toEqual({ kind: 'folder' });
    expect(s.get()).toBe(a); // memoized by raw string — same reference
  });

  it('sees an external write (cross-tab / written while unmounted) on the next read', () => {
    const s = objStore();
    s.set({ kind: 'a' });
    const a = s.get();
    // Simulate another tab writing directly to localStorage (no event delivered
    // to a notify handler) — the next get() must still observe it, not the memo.
    window.localStorage.setItem(KEY, JSON.stringify({ kind: 'b' }));
    const b = s.get();
    expect(b).toEqual({ kind: 'b' });
    expect(b).not.toBe(a);
  });

  it('set dispatches the change event; subscribe fires on event + storage and stops after unsubscribe', () => {
    const s = objStore();
    const onChange = vi.fn();
    const unsub = s.subscribe(onChange);

    s.set({ kind: 'x' }); // dispatches EVENT
    expect(onChange).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage')); // cross-tab signal
    expect(onChange).toHaveBeenCalledTimes(2);

    unsub();
    s.set({ kind: 'y' });
    window.dispatchEvent(new StorageEvent('storage'));
    expect(onChange).toHaveBeenCalledTimes(2); // no more after unsubscribe
  });

  it('resetForTest drops the parse memo', () => {
    const s = objStore();
    s.set({ kind: 'kept' });
    expect(s.get()).toEqual({ kind: 'kept' });
    window.localStorage.clear();
    // Without a reset the memo could still echo the prior raw string; reset makes
    // the cleared store read as default again.
    s.resetForTest();
    expect(s.get()).toEqual({ kind: 'default' });
  });

  it('reverts a refused write by default, and holds it when asked to', () => {
    // Default: what is stored wins, because something else may read the same key
    // directly (settingsSync does, for the synced prefs) and a held value would
    // split the two. Opted in: the change is kept for the session instead of
    // vanishing unannounced, which is what a store nothing else reads wants.
    const plain = objStore();
    plain.set({ kind: 'stored' });
    const setItem = refuseWrites();
    plain.set({ kind: 'refused' });
    expect(plain.get()).toEqual({ kind: 'stored' });
    expect(plain.hasUnpersistedValue()).toBe(false);
    setItem.mockRestore();

    window.localStorage.clear();
    const holding = holdingStore();
    holding.set({ kind: 'stored' });
    refuseWrites();
    holding.set({ kind: 'refused' });
    expect(holding.get()).toEqual({ kind: 'refused' });
    expect(holding.hasUnpersistedValue()).toBe(true);
    // Storage still holds the old value; the held one is what readers see.
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify({ kind: 'stored' }));
  });

  it('installs the held value BEFORE notifying', () => {
    // Subscribers re-read synchronously from inside the notification, so a value
    // assigned afterwards is invisible to them and schedules no render.
    const s = holdingStore();
    const seen: Obj[] = [];
    const unsub = s.subscribe(() => seen.push(s.get()));
    refuseWrites();
    s.set({ kind: 'refused' });
    unsub();
    expect(seen).toEqual([{ kind: 'refused' }]);
  });

  it('drops the held value once storage takes a write again', () => {
    const s = holdingStore();
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    s.set({ kind: 'refused' });
    expect(s.hasUnpersistedValue()).toBe(true);
    s.set({ kind: 'recovered' });
    expect(s.hasUnpersistedValue()).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe(
      JSON.stringify({ kind: 'recovered' }),
    );
    setItem.mockRestore();
    s.resetForTest();
    expect(s.get()).toEqual({ kind: 'recovered' });
  });

  it('drops the held value when somebody else writes the key', () => {
    // Another tab, or a module that writes the key directly. Storage is the
    // current answer again, so masking it with a value from before that write
    // would show one thing while the writer syncs another.
    const s = holdingStore();
    const setItem = refuseWrites();
    s.set({ kind: 'refused' });
    expect(s.get()).toEqual({ kind: 'refused' });
    setItem.mockRestore();

    window.localStorage.setItem(KEY, JSON.stringify({ kind: 'elsewhere' }));
    expect(s.get()).toEqual({ kind: 'elsewhere' });
    expect(s.hasUnpersistedValue()).toBe(false);
  });

  it('discards the stored value on a refused write when asked to', () => {
    // A cache of something else: what is stored is now known to be out of date,
    // and it outlives the in-memory copy — after a reload it would read as
    // current and win over the source it was caching.
    const s = holdingStore(true);
    s.set({ kind: 'stored' });
    refuseWrites();
    s.set({ kind: 'refused' });
    // Held in memory for this session...
    expect(s.get()).toEqual({ kind: 'refused' });
    // ...and nothing stale left behind for the next one.
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('serializes primitives with String() when no serialize is given', () => {
    const s = createPersistentStore<boolean>({
      storageKey: KEY,
      changeEvent: EVENT,
      defaultValue: false,
      parse: (raw) => raw === '1',
      serialize: (v) => (v ? '1' : '0'),
    });
    s.set(true);
    expect(window.localStorage.getItem(KEY)).toBe('1');
    expect(s.get()).toBe(true);
  });
});
