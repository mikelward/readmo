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
