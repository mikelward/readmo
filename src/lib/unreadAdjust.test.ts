import { describe, expect, it } from 'vitest';
import { UnreadDecrementLedger, adjustUnreadIds } from './unreadAdjust';
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

const NONE: ReadonlySet<ItemId> = new Set();

describe('UnreadDecrementLedger', () => {
  it('passes counts through untouched when nothing is pending (e.g. the mock)', () => {
    const ledger = new UnreadDecrementLedger();
    const counts = { f1: 6 };
    const rows = [row('a', 'f1'), row('b', 'f1')];
    const states = { a: st({ done: true }), b: st({ done: true }) };
    ledger.noteDismissals(rows, lookup(states), NONE);
    expect(ledger.apply(counts)).toBe(counts);
  });

  it('subtracts pending Sweep/Done rows from their feed count', () => {
    const ledger = new UnreadDecrementLedger();
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
    ledger.noteDismissals(rows, lookup(states), new Set(['s1', 's2', 's3']));
    // 6 server count − 3 just-swept = 3 (the pins, which still count).
    expect(ledger.apply(counts)).toEqual({ f1: 3 });
  });

  it('never subtracts a pinned row (a pin is a to-do, read or not)', () => {
    const ledger = new UnreadDecrementLedger();
    // Read but still pinned → counted server-side and now → no decrement.
    const states = { p: st({ pinned: true, opened: true }) };
    ledger.noteDismissals([row('p', 'f1')], lookup(states), new Set(['p']));
    const counts = { f1: 4 };
    expect(ledger.apply(counts)).toBe(counts);
  });

  it('does not subtract an already-read (Opened) row — it was never counted', () => {
    const ledger = new UnreadDecrementLedger();
    const states = { readThenDone: st({ opened: true, done: true }) };
    ledger.noteDismissals(
      [row('readThenDone', 'f1')],
      lookup(states),
      new Set(['readThenDone']),
    );
    const counts = { f1: 3 };
    expect(ledger.apply(counts)).toBe(counts);
  });

  it('does NOT over-subtract a coalesced pin→unpin that never reached the server', () => {
    // Codex P2: an already-Opened row pinned then unpinned before the first write
    // syncs. The server still has pinned:false (never counted it), and the
    // outbox has coalesced to {pinned:false}. Reading only the current state
    // (done:false) means we correctly leave the count alone instead of inferring
    // a phantom server pin and dropping the badge too low.
    const ledger = new UnreadDecrementLedger();
    const states = { pinUnpin: st({ opened: true, pinned: false }) };
    ledger.noteDismissals([row('pinUnpin', 'f1')], lookup(states), new Set(['pinUnpin']));
    const counts = { f1: 2 };
    expect(ledger.apply(counts)).toBe(counts);
  });

  it('leaves a pinned-then-read row marked Done lagging (conservative, self-heals on sync)', () => {
    // Known, accepted miss: the pin was cleared by Done but `opened` is still
    // true, and we refuse to guess that it used to be a server-counted pin (that
    // guess is unsound under coalescing). The server count drops on the next
    // sync + refetch. Documented so the conservative choice is explicit.
    const ledger = new UnreadDecrementLedger();
    const states = { pinReadDone: st({ done: true, opened: true, pinned: false }) };
    ledger.noteDismissals(
      [row('pinReadDone', 'f1')],
      lookup(states),
      new Set(['pinReadDone']),
    );
    const counts = { f1: 3 };
    expect(ledger.apply(counts)).toBe(counts);
  });

  it('subtracts active-Hidden (swipe-to-dismiss) rows too', () => {
    const ledger = new UnreadDecrementLedger();
    const states = { h: st({ hidden: true }) };
    ledger.noteDismissals([row('h', 'f1')], lookup(states), new Set(['h']));
    expect(ledger.apply({ f1: 2 })).toEqual({ f1: 1 });
  });

  it('floors at 0 and only touches feeds present in the count map', () => {
    const ledger = new UnreadDecrementLedger();
    const rows = [row('s1', 'f1'), row('s2', 'f1'), row('x', 'f2')];
    const states = {
      s1: st({ done: true }),
      s2: st({ done: true }),
      x: st({ done: true }),
    };
    ledger.noteDismissals(rows, lookup(states), new Set(['s1', 's2', 'x']));
    expect(ledger.apply({ f1: 1 })).toEqual({ f1: 0 });
  });

  it('only notes pending rows, even when others are locally Done', () => {
    const ledger = new UnreadDecrementLedger();
    const rows = [row('pendingDone', 'f1'), row('oldDone', 'f1')];
    const states = {
      pendingDone: st({ done: true }),
      oldDone: st({ done: true }),
    };
    ledger.noteDismissals(rows, lookup(states), new Set(['pendingDone']));
    expect(ledger.apply({ f1: 5 })).toEqual({ f1: 4 });
  });

  it('keeps the decrement after the write drains, until a reflecting count lands', () => {
    // The flicker this class exists to kill: pending clears at write-confirm,
    // one round-trip before the refetched count arrives. The decrement must
    // hold through that gap instead of bouncing the badge back up.
    const ledger = new UnreadDecrementLedger();
    const states = { s: st({ done: true }) };
    ledger.noteDismissals([row('s', 'f1')], lookup(states), new Set(['s']));
    expect(ledger.apply({ f1: 3 })).toEqual({ f1: 2 });

    // Outbox drained: `s` left the pending set, but the only count we have is
    // still the stale pre-sync one — keep discounting it.
    ledger.noteDismissals([row('s', 'f1')], lookup(states), NONE);
    ledger.retire(null, lookup(states));
    expect(ledger.apply({ f1: 3 })).toEqual({ f1: 2 });
  });

  it('retires a decrement exactly when a count fetched after its drain lands', () => {
    const ledger = new UnreadDecrementLedger();
    const states = { s: st({ done: true }) };
    ledger.noteDismissals([row('s', 'f1')], lookup(states), new Set(['s']));

    // Fetch started while the write was still pending → its response does NOT
    // reflect the write; the snapshot is empty and the decrement survives.
    expect(ledger.drainedIds(new Set(['s']), new Set(['f1'])).entries).toEqual([]);
    ledger.retire(null, lookup(states));
    expect(ledger.apply({ f1: 3 })).toEqual({ f1: 2 });

    // Fetch started after the drain → its response counts the write; retiring
    // the snapshot as it lands swaps decrement for server truth with no gap.
    const reflected = ledger.drainedIds(NONE, new Set(['f1']));
    expect(reflected.entries.map((r) => r.id)).toEqual(['s']);
    ledger.retire(reflected, lookup(states));
    expect(ledger.apply({ f1: 2 })).toEqual({ f1: 2 });
  });

  it('a stale reflected snapshot cannot retire a re-dismissal (undo → dismiss again)', () => {
    // Codex P2 on #442: the current response's snapshot is re-applied on every
    // render. If the user restores an item whose dismissal that snapshot
    // reflects and then dismisses it again before a fresh count lands, the
    // stale snapshot must not retire the NEW dismissal's decrement — the
    // response pre-dates it, so the badge would overstate until the second
    // write synced.
    const ledger = new UnreadDecrementLedger();
    const dismissed = { s: st({ done: true }) };
    ledger.noteDismissals([row('s', 'f1')], lookup(dismissed), new Set(['s']));

    // The write drains and a count fetch starts: its snapshot reflects the
    // FIRST dismissal.
    const staleSnapshot = ledger.drainedIds(NONE, new Set(['f1']));
    expect(staleSnapshot.entries.map((r) => r.id)).toEqual(['s']);

    // Before that fetch lands: Undo restores the row (decrement retires)…
    ledger.retire(null, lookup({ s: st() }));
    // …and the user dismisses it again (a new pending write, a new decrement).
    ledger.noteDismissals([row('s', 'f1')], lookup(dismissed), new Set(['s']));

    // The stale snapshot now lands (and keeps re-applying while its response
    // stays current): the re-dismissal's decrement survives it.
    ledger.retire(staleSnapshot, lookup(dismissed));
    ledger.retire(staleSnapshot, lookup(dismissed));
    expect(ledger.apply({ f1: 3 })).toEqual({ f1: 2 });
  });

  it('a count response only retires entries for the feeds it was asked about', () => {
    // Codex P2 on #442: a fetch snapshots the drained entries at start, but
    // the response only covers `feedIds` — the feeds whose headers are in
    // view. A drained entry for an out-of-view feed must survive that
    // response: its feed's cached count is still the stale pre-dismissal one,
    // and retiring the decrement would let it paint overstated when the feed
    // comes back into view before its own count refetches.
    const ledger = new UnreadDecrementLedger();
    const states = { a: st({ done: true }) };
    ledger.noteDismissals([row('a', 'fA')], lookup(states), new Set(['a']));

    // Write drained; a fetch scoped to feed B only must not claim A's entry…
    expect(ledger.drainedIds(NONE, new Set(['fB'])).entries).toEqual([]);
    ledger.retire(null, lookup(states));
    expect(ledger.apply({ fA: 3 })).toEqual({ fA: 2 });

    // …while a fetch that covers feed A retires it as its response lands.
    const snap = ledger.drainedIds(NONE, new Set(['fA', 'fB']));
    expect(snap.entries.map((r) => r.id)).toEqual(['a']);
    ledger.retire(snap, lookup(states));
    expect(ledger.apply({ fA: 2 })).toEqual({ fA: 2 });
  });

  it('a snapshot replayed from cached data cannot retire another ledger instance’s entries', () => {
    // Codex P2 on #442: React Query caches (and persists) the count response,
    // `reflected` snapshot included. After a remount/reload a FRESH ledger —
    // its generation counter restarted — can be handed a replayed snapshot
    // whose {id, gen} pairs recycle values the new instance is also minting;
    // without the instance token that would spuriously retire a brand-new
    // dismissal's decrement.
    const states = { s: st({ done: true }) };
    const previous = new UnreadDecrementLedger();
    previous.noteDismissals([row('s', 'f1')], lookup(states), new Set(['s']));
    const cached = previous.drainedIds(NONE, new Set(['f1'])); // gen 1, old instance

    const fresh = new UnreadDecrementLedger();
    fresh.noteDismissals([row('s', 'f1')], lookup(states), new Set(['s'])); // gen 1 again
    fresh.retire(cached, lookup(states));
    expect(fresh.apply({ f1: 3 })).toEqual({ f1: 2 });

    // The fresh instance's own snapshot still retires normally.
    const own = fresh.drainedIds(NONE, new Set(['f1']));
    fresh.retire(own, lookup(states));
    expect(fresh.apply({ f1: 2 })).toEqual({ f1: 2 });
  });

  it('retires a decrement immediately when the dismissal is undone', () => {
    const ledger = new UnreadDecrementLedger();
    const before = { s: st({ done: true }) };
    ledger.noteDismissals([row('s', 'f1')], lookup(before), new Set(['s']));
    expect(ledger.apply({ f1: 3 })).toEqual({ f1: 2 });

    // Undo restored the row: it's back in the list, so the badge must count it
    // again right away — whatever the sync state of the writes.
    const after = { s: st({ done: false }) };
    ledger.retire(null, lookup(after));
    const counts = { f1: 3 };
    expect(ledger.apply(counts)).toBe(counts);
  });

  it('holds a decrement even after its row drops out of the loaded pages', () => {
    // A list refetch removes dismissed rows from the cached pages before the
    // count refetch lands; the decrement is keyed by id, not row presence, so
    // the badge must not bounce up in that window.
    const ledger = new UnreadDecrementLedger();
    const states = { s: st({ done: true }) };
    ledger.noteDismissals([row('s', 'f1')], lookup(states), new Set(['s']));

    // Row gone from the pages; later renders note over the remaining rows only.
    ledger.noteDismissals([], lookup(states), new Set(['s']));
    ledger.retire(null, lookup(states));
    expect(ledger.apply({ f1: 3 })).toEqual({ f1: 2 });
  });

  it('does not double-note a row across renders', () => {
    const ledger = new UnreadDecrementLedger();
    const states = { s: st({ done: true }) };
    const rows = [row('s', 'f1')];
    const pending = new Set<ItemId>(['s']);
    ledger.noteDismissals(rows, lookup(states), pending);
    ledger.noteDismissals(rows, lookup(states), pending);
    ledger.noteDismissals(rows, lookup(states), pending);
    expect(ledger.apply({ f1: 3 })).toEqual({ f1: 2 });
  });
});

describe('adjustUnreadIds', () => {
  it('counts the server ids as-is when local state still agrees', () => {
    const serverIds = { f1: ['a', 'b', 'c'], f2: ['d'] };
    expect(
      adjustUnreadIds(serverIds, ['f1', 'f2'], [], lookup({}), NONE),
    ).toEqual({ f1: 3, f2: 1 });
  });

  it('returns 0 for a requested feed the server set omits', () => {
    expect(adjustUnreadIds({ f1: ['a'] }, ['f1', 'f2'], [], lookup({}), NONE)).toEqual({
      f1: 1,
      f2: 0,
    });
  });

  it('drops a server id that local triage took out of the unread set', () => {
    const serverIds = { f1: ['a', 'b', 'c'] };
    // a→Done, b→active-Hidden, c→Opened (un-pinned): all no longer unread.
    const states = {
      a: st({ done: true }),
      b: st({ hidden: true }),
      c: st({ opened: true }),
    };
    expect(adjustUnreadIds(serverIds, ['f1'], [], lookup(states), NONE)).toEqual({
      f1: 0,
    });
  });

  it('keeps a pinned server id even after it is Opened (a pin always counts)', () => {
    const states = { a: st({ pinned: true, opened: true }) };
    expect(
      adjustUnreadIds({ f1: ['a', 'b'] }, ['f1'], [], lookup(states), NONE),
    ).toEqual({ f1: 2 });
  });

  it('adds a locally-pinned loaded row the server set omits, deduping the ones it has', () => {
    // p is pinned locally but not in the server set (pin not synced / was read);
    // b is already in the set and also pinned — must not be double-counted.
    const states = { p: st({ pinned: true }), b: st({ pinned: true }) };
    const rows = [row('p', 'f1'), row('b', 'f1')];
    expect(
      adjustUnreadIds({ f1: ['b', 'c'] }, ['f1'], rows, lookup(states), NONE),
    ).toEqual({ f1: 3 }); // b, c, and the added p
  });

  it('does NOT re-add a non-pinned loaded row the server set omits (stale row / pre-sync restore)', () => {
    // Additions are pins-only. An out-of-window unread item is listable ONLY via
    // the floor or a pin; the client can verify a pin but not floor membership,
    // so trusting a non-pinned loaded row would resurrect a STALE one the server
    // legitimately dropped (e.g. an old item that was listable only via a
    // since-removed pin). A non-pinned row Undone before its restore syncs is the
    // accepted flip side: it shows one low for the round-trip, a transient the
    // ledger has too. Either way the non-pinned 'x' stays out here.
    const states = { x: st() }; // unpinned, unopened, not done/hidden
    const rows = [row('x', 'f1')];
    expect(
      adjustUnreadIds({ f1: ['a'] }, ['f1'], rows, lookup(states), NONE),
    ).toEqual({ f1: 1 }); // only the server's 'a'
  });

  it('does not add a pinned loaded row that is also Done or Hidden', () => {
    const states = {
      p: st({ pinned: true, done: true }),
      q: st({ pinned: true, hidden: true }),
    };
    const rows = [row('p', 'f1'), row('q', 'f1')];
    expect(adjustUnreadIds({ f1: [] }, ['f1'], rows, lookup(states), NONE)).toEqual({
      f1: 0,
    });
  });

  it('ignores loaded rows whose feed is out of view', () => {
    const states = { p: st({ pinned: true }) };
    const rows = [row('p', 'f2')]; // f2 not requested
    expect(adjustUnreadIds({ f1: ['a'] }, ['f1'], rows, lookup(states), NONE)).toEqual(
      { f1: 1 },
    );
  });

  it('provisionally removes a buffered exit-top row before its write commits', () => {
    // a is still in the server set and still locally unread (write deferred), but
    // it has scrolled off the top — discount it now.
    const rows = [row('a', 'f1'), row('b', 'f1')];
    expect(
      adjustUnreadIds({ f1: ['a', 'b'] }, ['f1'], rows, lookup({}), new Set(['a'])),
    ).toEqual({ f1: 1 });
  });

  it('does not remove a buffered row that is pinned (shielded from the flush)', () => {
    const states = { a: st({ pinned: true }) };
    const rows = [row('a', 'f1'), row('b', 'f1')];
    expect(
      adjustUnreadIds(
        { f1: ['a', 'b'] },
        ['f1'],
        rows,
        lookup(states),
        new Set(['a']),
      ),
    ).toEqual({ f1: 2 });
  });
});
