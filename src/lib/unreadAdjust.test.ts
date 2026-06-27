import { describe, expect, it } from 'vitest';
import { adjustUnreadCounts } from './unreadAdjust';
import type { FeedId, ItemId, ItemState } from './types';

function st(over: Partial<ItemState> = {}): ItemState {
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

function row(id: ItemId, feedId: FeedId) {
  return { item: { id, feedId } };
}

function lookup(map: Record<ItemId, ItemState>) {
  return (id: ItemId) => map[id] ?? st();
}

describe('adjustUnreadCounts', () => {
  it('passes counts through untouched when nothing is pending (e.g. the mock)', () => {
    const counts = { f1: 6 };
    const rows = [row('a', 'f1'), row('b', 'f1')];
    const states = { a: st({ done: true }), b: st({ done: true }) };
    expect(adjustUnreadCounts(counts, rows, lookup(states), new Set())).toBe(
      counts,
    );
  });

  it('subtracts pending Sweep/Done rows from their feed count', () => {
    const counts = { f1: 6 };
    const rows = ['p1', 'p2', 'p3', 's1', 's2', 's3'].map((id) => row(id, 'f1'));
    const states = {
      p1: st({ pinned: true }),
      p2: st({ pinned: true }),
      p3: st({ pinned: true }),
      s1: st({ done: true }),
      s2: st({ done: true }),
      s3: st({ done: true }),
    };
    // Only the swept rows are pending; pins have no un-synced write.
    const pending = new Set(['s1', 's2', 's3']);
    // 6 server count − 3 just-swept = 3 (the pins, which still count).
    expect(adjustUnreadCounts(counts, rows, lookup(states), pending)).toEqual({
      f1: 3,
    });
  });

  it('never subtracts a pinned row (a pin is a to-do, read or not)', () => {
    const counts = { f1: 4 };
    const rows = [row('p', 'f1')];
    // Read but still pinned → counted server-side and now → no decrement.
    const states = { p: st({ pinned: true, opened: true }) };
    expect(
      adjustUnreadCounts(counts, rows, lookup(states), new Set(['p'])),
    ).toEqual({ f1: 4 });
  });

  it('does not subtract an already-read (Opened) row — it was never counted', () => {
    const counts = { f1: 3 };
    const rows = [row('readThenDone', 'f1')];
    const states = { readThenDone: st({ opened: true, done: true }) };
    expect(
      adjustUnreadCounts(counts, rows, lookup(states), new Set(['readThenDone'])),
    ).toEqual({ f1: 3 });
  });

  it('does NOT over-subtract a coalesced pin→unpin that never reached the server', () => {
    // Codex P2: an already-Opened row pinned then unpinned before the first write
    // syncs. The server still has pinned:false (never counted it), and the
    // outbox has coalesced to {pinned:false}. Reading only the current state
    // (done:false) means we correctly leave the count alone instead of inferring
    // a phantom server pin and dropping the badge too low.
    const counts = { f1: 2 };
    const rows = [row('pinUnpin', 'f1')];
    const states = { pinUnpin: st({ opened: true, pinned: false }) };
    expect(
      adjustUnreadCounts(counts, rows, lookup(states), new Set(['pinUnpin'])),
    ).toEqual({ f1: 2 });
  });

  it('leaves a pinned-then-read row marked Done lagging (conservative, self-heals on sync)', () => {
    // Known, accepted miss: the pin was cleared by Done but `opened` is still
    // true, and we refuse to guess that it used to be a server-counted pin (that
    // guess is unsound under coalescing). The server count drops on the next
    // sync. Documented so the conservative choice is explicit.
    const counts = { f1: 3 };
    const rows = [row('pinReadDone', 'f1')];
    const states = { pinReadDone: st({ done: true, opened: true, pinned: false }) };
    expect(
      adjustUnreadCounts(counts, rows, lookup(states), new Set(['pinReadDone'])),
    ).toEqual({ f1: 3 });
  });

  it('subtracts active-Hidden (swipe-to-dismiss) rows too', () => {
    const counts = { f1: 2 };
    const rows = [row('h', 'f1')];
    const states = { h: st({ hidden: true }) };
    expect(
      adjustUnreadCounts(counts, rows, lookup(states), new Set(['h'])),
    ).toEqual({ f1: 1 });
  });

  it('ignores rows whose write has already synced (absent from pending)', () => {
    const counts = { f1: 3 }; // server already reflects the synced Done
    const rows = [row('synced', 'f1')];
    const states = { synced: st({ done: true }) };
    expect(adjustUnreadCounts(counts, rows, lookup(states), new Set())).toBe(
      counts,
    );
  });

  it('floors at 0 and only touches feeds present in the count map', () => {
    const counts = { f1: 1 };
    const rows = [row('s1', 'f1'), row('s2', 'f1'), row('x', 'f2')];
    const states = {
      s1: st({ done: true }),
      s2: st({ done: true }),
      x: st({ done: true }),
    };
    expect(
      adjustUnreadCounts(counts, rows, lookup(states), new Set(['s1', 's2', 'x'])),
    ).toEqual({ f1: 0 });
  });

  it('only counts pending rows, even when others are locally Done', () => {
    const counts = { f1: 5 };
    const rows = [row('pendingDone', 'f1'), row('oldDone', 'f1')];
    const states = {
      pendingDone: st({ done: true }),
      oldDone: st({ done: true }),
    };
    expect(
      adjustUnreadCounts(counts, rows, lookup(states), new Set(['pendingDone'])),
    ).toEqual({ f1: 4 });
  });
});
