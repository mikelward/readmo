import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markReverseSyncPending,
  isReverseSyncPending,
  clearAllReverseSyncPending,
  subscribeReverseSyncPending,
  _resetReverseSyncPendingForTests,
} from './newshackerReverseSyncPending';

const KEY = 'readmo:newshacker-reverse-pending';

beforeEach(() => {
  sessionStorage.clear();
  _resetReverseSyncPendingForTests();
});

describe('newshackerReverseSyncPending', () => {
  it('marks an id pending and reports it, isolated per id', () => {
    expect(isReverseSyncPending('a')).toBe(false);
    markReverseSyncPending('a');
    expect(isReverseSyncPending('a')).toBe(true);
    expect(isReverseSyncPending('b')).toBe(false);
  });

  it('clears every pending marker at once', () => {
    markReverseSyncPending('a');
    markReverseSyncPending('b');
    clearAllReverseSyncPending();
    expect(isReverseSyncPending('a')).toBe(false);
    expect(isReverseSyncPending('b')).toBe(false);
  });

  it('survives a fresh page load via sessionStorage (the newshacker round-trip)', () => {
    markReverseSyncPending('a');
    // Simulate readmo.app reloading after the same-tab hop to newshacker and
    // back: the module is re-evaluated (in-memory mirror reset) but
    // sessionStorage persists.
    _resetReverseSyncPendingForTests();
    expect(isReverseSyncPending('a')).toBe(true);
  });

  it('drops a marker past the max-age failsafe', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify([{ id: 'a', at: Date.now() - 31 * 60 * 1000 }]),
    );
    _resetReverseSyncPendingForTests();
    expect(isReverseSyncPending('a')).toBe(false);
  });

  it('notifies subscribers on mark and on clear', () => {
    const cb = vi.fn();
    const unsub = subscribeReverseSyncPending(cb);
    markReverseSyncPending('a');
    expect(cb).toHaveBeenCalledTimes(1);
    clearAllReverseSyncPending();
    expect(cb).toHaveBeenCalledTimes(2);
    // A no-op clear (already empty) doesn't notify.
    clearAllReverseSyncPending();
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
  });

  it('tolerates unavailable/corrupt storage', () => {
    sessionStorage.setItem(KEY, 'not json');
    _resetReverseSyncPendingForTests();
    expect(isReverseSyncPending('a')).toBe(false);
    // still writable afterward
    markReverseSyncPending('a');
    expect(isReverseSyncPending('a')).toBe(true);
  });
});
