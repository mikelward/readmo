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
  });

  it('stamps the action time when a field is turned off (kept as the last-change clock)', () => {
    const prev = applyMutation(DEFAULT_ITEM_STATE, 'pinned', true, NOW);
    const next = applyMutation(prev, 'pinned', false, NOW + 1);
    expect(next.pinned).toBe(false);
    // `<f>At` is the field's last-change clock, kept even when false so a later
    // hydrate can reconcile per-field by last-write-wins against the server.
    expect(next.pinnedAt).toBe(NOW + 1);
  });

  it('stamps exclusivity-cleared fields with the same action time', () => {
    const prev = state({ done: true, doneAt: NOW, hidden: true, hiddenAt: NOW });
    const next = applyMutation(prev, 'pinned', true, NOW + 5);
    // Pin clears Done+Hidden; all three carry the pin's `now`, so an LWW merge
    // keeps them winning together (no stale per-field split).
    expect(next.pinnedAt).toBe(NOW + 5);
    expect(next.doneAt).toBe(NOW + 5);
    expect(next.hiddenAt).toBe(NOW + 5);
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
    store.hydrate([['b', state({ pinned: true, pinnedAt: NOW })]], new Map(), NOW);
    expect(events).toHaveLength(2); // unchanged — no mutation event for hydrate
  });

  it('subscribeSynced fires only on notifySynced (outbox drain), not on mutation', () => {
    const store = new ItemStateStore(memoryPersistence());
    let synced = 0;
    let general = 0;
    const off = store.subscribeSynced(() => synced++);
    store.subscribe(() => general++);

    // A user mutation wakes the general listeners but NOT subscribeSynced.
    store.set('a', 'done', true, NOW);
    expect(general).toBe(1);
    expect(synced).toBe(0);

    // An outbox drain wakes both: subscribeSynced (the drain-specific channel)
    // and the general listeners (so the unread-count query re-reads).
    store.notifySynced();
    expect(synced).toBe(1);
    expect(general).toBe(2);

    // Unsubscribing stops the drain callbacks.
    off();
    store.notifySynced();
    expect(synced).toBe(1);
    expect(general).toBe(3);
  });

  it('subscribeHydrated fires only on a map-changing hydration, not mutation/synced/no-op', () => {
    const store = new ItemStateStore(memoryPersistence());
    let hydrated = 0;
    let general = 0;
    const off = store.subscribeHydrated(() => hydrated++);
    store.subscribe(() => general++);

    // A local mutation wakes the general listeners but NOT subscribeHydrated —
    // this is what keeps a local triage action from refetching the feed.
    store.set('a', 'done', true, NOW);
    expect(general).toBe(1);
    expect(hydrated).toBe(0);

    // An outbox drain wakes the general listeners but NOT subscribeHydrated.
    store.notifySynced();
    expect(general).toBe(2);
    expect(hydrated).toBe(0);

    // A hydration that changes the map wakes both: the cross-device row that
    // needs a feed reconcile fires the hydrated channel.
    store.hydrate([['b', state({ pinned: true, pinnedAt: NOW })]], new Map(), NOW);
    expect(hydrated).toBe(1);
    expect(general).toBe(3);

    // A no-op hydration (identical state) changes nothing and must stay silent
    // on BOTH channels — no needless feed read on a routine focus resync.
    store.hydrate([['b', state({ pinned: true, pinnedAt: NOW })]], new Map(), NOW);
    expect(hydrated).toBe(1);
    expect(general).toBe(3);

    // Unsubscribing stops the hydrated callbacks.
    off();
    store.hydrate([['c', state({ done: true, doneAt: NOW })]], new Map(), NOW);
    expect(hydrated).toBe(1);
    expect(general).toBe(4);
  });

  it('hidden→Done migration (constructor) surfaces a legacy hidden row in /done', () => {
    // A legacy hidden row: the constructor migrates it to Done so it surfaces in
    // /done instead of being invisible with no recovery path.
    // The constructor migration uses real Date.now(), so the hidden timestamp
    // must be recent (un-expired) for it to fire.
    const now = Date.now();
    // Strictly older than the constructor's own Date.now() stamp (a same-ms
    // tie would be resolved to the server below — realistic hide actions are
    // always older than the boot that migrates them).
    const hiddenAt = now - 1000;
    let saved: Record<string, ItemState> = {
      a: state({ hidden: true, hiddenAt }),
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
    // The migration stamps the hidden-clear with its own clock, so a hydrate
    // still carrying the server's (never-migrated) hidden row can't win LWW
    // and resurrect hidden=true next to the migrated Done.
    store.hydrate([['a', state({ hidden: true, hiddenAt })]], new Map(), now + 10);
    const after = store.get('a', now + 10);
    expect(after.done).toBe(true);
    expect(after.hidden).toBe(false);
  });

  it('hidden→Done migration (hydrate) surfaces a legacy hidden server row in /done', () => {
    const store = new ItemStateStore(memoryPersistence());
    // Server returns a legacy hidden row; hydrate migrates it to Done locally.
    store.hydrate([['a', state({ hidden: true, hiddenAt: NOW })]], new Map(), NOW);
    const a = store.get('a', NOW);
    expect(a.done).toBe(true);
    expect(a.hidden).toBe(false);
  });

  it('hidden→Done migration sticks across repeated hydrates of the unchanged server row', () => {
    // The migration is local-only (hydrate never fires the sink), so the server
    // keeps hidden=true with its old clock. The migrated row must carry a NEWER
    // hidden clock — a nulled one would lose the next resync's per-field LWW,
    // resurrecting hidden=true alongside the migrated Done, and "Unmark done"
    // would then strand the item invisible in every view until the hidden TTL.
    const store = new ItemStateStore(memoryPersistence());
    const serverRow = state({ hidden: true, hiddenAt: NOW });
    store.hydrate([['a', serverRow]], new Map(), NOW + 10);
    // The next focus/online resync re-delivers the same (never-migrated) row.
    store.hydrate([['a', serverRow]], new Map(), NOW + 20);
    const a = store.get('a', NOW + 20);
    expect(a.done).toBe(true);
    expect(a.hidden).toBe(false);
    // The recovery path stays open: unmarking Done leaves the row fully
    // visible rather than re-hiding it.
    store.set('a', 'done', false, NOW + 30);
    const restored = store.get('a', NOW + 30);
    expect(restored.done).toBe(false);
    expect(restored.hidden).toBe(false);
  });

  it('write-through sink fires the changed-field diff (set / hide / undo), not on hydrate', () => {
    const store = new ItemStateStore(memoryPersistence());
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));

    store.set('a', 'pinned', true);
    store.hide('b'); // done = true (undoable)
    store.undoLast(); // reverts b -> done false
    // Hydration overlays server rows and must NOT write back through the sink.
    store.hydrate([['c', { ...DEFAULT_ITEM_STATE, done: true }]]);

    // The sink receives the exclusivity-closed diff: a Pin carries the cleared
    // done/hidden even though they were already false locally (so a stale mirror
    // can't leave an invalid pinned+done row on the server); a dismiss carries the
    // cleared pinned.
    expect(calls).toEqual([
      ['a', { pinned: true, done: false, hidden: false }],
      ['b', { done: true, pinned: false }],
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
      // Restoring the pin re-closes its exclusivity (done+hidden cleared).
      ['x', { pinned: true, done: false, hidden: false }],
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

  it('closes a Pin over done/hidden even when the local mirror already shows them false', () => {
    // The local mirror can lag the server — another device set done=true and this
    // tab hasn't hydrated it, so done reads as false locally. A Pin must STILL
    // send done:false / hidden:false (the action's exclusivity closure), or
    // per-field LWW would leave the server's done=true untouched → invalid
    // pinned+done. The sink closure guarantees this regardless of mirror staleness.
    const store = new ItemStateStore(memoryPersistence());
    const sink: Array<[string, Partial<Record<string, boolean>>]> = [];
    const seen: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => sink.push([id, changed]));
    store.subscribeMutations((id, changed) => seen.push([id, changed]));
    store.set('a', 'pinned', true); // local done/hidden already false

    expect(sink).toEqual([['a', { pinned: true, done: false, hidden: false }]]);
    // The in-session mutation listeners still get the NATURAL diff (what changed
    // for this user on this device), not the server closure.
    expect(seen).toEqual([['a', { pinned: true }]]);
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
    expect(calls).toEqual([['z', { done: true, pinned: false }]]);
    expect(store.get('z', later).done).toBe(true); // no longer expired
  });

  it('re-opening an opened article refreshes its clock AND syncs the refresh', () => {
    // /opened is the 30-day RECENTLY-opened history, so a re-open restamps
    // openedAt (retention re-anchors to the latest read) — but the restamp
    // must also reach the server: a silently restamped local clock with no
    // matching write would win hydrate's LWW against legitimate cross-device
    // writes forever (the split-brain this suite guards against).
    const store = new ItemStateStore(memoryPersistence());
    store.set('a', 'opened', true, NOW);
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));

    store.set('a', 'opened', true, NOW + 5_000); // re-open

    // The refresh writes through, so server and local clocks stay in step.
    expect(calls).toEqual([['a', { opened: true }]]);
    // The re-open is a real (synced) write, so it legitimately wins LWW over
    // an OLDER cross-device "mark unread"…
    store.hydrate(
      [['a', state({ opened: false, openedAt: NOW + 1_000 })]],
      new Map(),
      NOW + 10_000,
    );
    expect(store.get('a', NOW + 10_000).opened).toBe(true);
    // …and loses to a NEWER one, exactly like any other write.
    store.hydrate(
      [['a', state({ opened: false, openedAt: NOW + 6_000 })]],
      new Map(),
      NOW + 10_000,
    );
    expect(store.get('a', NOW + 10_000).opened).toBe(false);
  });

  it('re-opening re-anchors the 30-day retention window to the latest open', () => {
    const store = new ItemStateStore(memoryPersistence());
    store.set('a', 'opened', true, NOW);
    store.set('a', 'opened', true, NOW + 5_000); // re-open
    // Still in /opened past the FIRST open's TTL boundary, gone after the
    // re-open's. (Reads are monotonic — get()'s retained-snapshot cache, like
    // production time, never runs backwards.)
    expect(store.get('a', NOW + TTL_MS + 1).opened).toBe(true);
    expect(store.get('a', NOW + 5_000 + TTL_MS + 1).opened).toBe(false);
  });

  it('re-asserting a non-TTL flag or an already-false value is a full no-op', () => {
    // No recency to refresh (Pinned/Favorite never expire; false carries no
    // window), so nothing may restamp, write through, or notify — a silent
    // local restamp with no server write would poison LWW (see above).
    const store = new ItemStateStore(memoryPersistence());
    store.set('a', 'pinned', true, NOW);
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));
    let notified = 0;
    store.subscribe(() => notified++);

    store.set('a', 'pinned', true, NOW + 5_000); // still pinned
    store.set('a', 'hidden', false, NOW + 5_000); // already false

    expect(calls).toEqual([]);
    expect(notified).toBe(0);
    // Clocks untouched → a newer cross-device unpin still wins.
    store.hydrate(
      [['a', state({ pinned: false, pinnedAt: NOW + 1_000 })]],
      new Map(),
      NOW + 10_000,
    );
    expect(store.get('a', NOW + 10_000).pinned).toBe(false);
  });

  it('hideMany skips already-Done ids without restamping their clocks', () => {
    const store = new ItemStateStore(memoryPersistence());
    store.set('d', 'done', true, NOW);
    const calls: Array<[string, Partial<Record<string, boolean>>]> = [];
    store.setMutationSink((id, changed) => calls.push([id, changed]));

    store.hideMany(['d', 'e'], NOW + 5_000); // d already done, e fresh

    // Only the fresh dismissal writes through.
    expect(calls).toEqual([['e', { done: true, pinned: false }]]);
    // d's clock is untouched, so a newer cross-device un-dismiss still wins.
    store.hydrate(
      [['d', state({ done: false, doneAt: NOW + 1_000 })]],
      new Map(),
      NOW + 10_000,
    );
    expect(store.get('d', NOW + 10_000).done).toBe(false);
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
      ['z', { done: true, pinned: false }],
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

    it('returns the ids it restored (in batch order), empty when nothing to undo', () => {
      const store = new ItemStateStore(memoryPersistence());
      expect(store.undoLast()).toEqual([]); // nothing recorded yet
      store.hideMany(['a', 'b'], NOW, { batchKey: 1 });
      store.hideMany(['c'], NOW, { batchKey: 1 }); // same burst
      expect(store.undoLast()).toEqual(['a', 'b', 'c']);
      expect(store.undoLast()).toEqual([]); // batch consumed
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

  describe('hydrate (server reconcile, per-field LWW)', () => {
    const srv = (over: Partial<ItemState>): ItemState => ({
      ...DEFAULT_ITEM_STATE,
      ...over,
    });

    it('adopts a server field whose change is NEWER than the local one', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true, NOW);
      // Another device marked a done LATER. The server row is exclusivity-closed
      // (the done-write stamped pinned=false@NOW+10 too), so per-field LWW adopts
      // the whole newer action together.
      const serverDone = applyMutation(DEFAULT_ITEM_STATE, 'done', true, NOW + 10);
      store.hydrate([['a', serverDone]], new Map(), NOW + 10);
      // Read at NOW+10 so the TTL'd Done isn't retention-expired against real time.
      expect(store.get('a', NOW + 10).pinned).toBe(false); // server's done cleared it
      expect(store.get('a', NOW + 10).done).toBe(true);
    });

    it('keeps a local field whose change is NEWER than the server row', () => {
      const store = new ItemStateStore(memoryPersistence());
      // Server shows an older done; the local pin is newer → local wins.
      store.set('a', 'pinned', true, NOW + 10);
      store.hydrate([['a', srv({ done: true, doneAt: NOW })]], new Map(), NOW + 10);
      expect(store.get('a').pinned).toBe(true);
      expect(store.get('a').done).toBe(false); // pin@NOW+10 cleared done, newer than server
    });

    it('drops a local-only row the server omits when it is NOT protected', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true);
      store.hydrate([], new Map()); // server has no rows; a is not protected
      expect(store.get('a')).toEqual(DEFAULT_ITEM_STATE); // cleared
    });

    it('preserves a protected local-only row the server has not yet got', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true); // optimistic, write still un-synced
      store.hydrate([], new Map([['a', {}]])); // a protected → keep the optimistic pin
      expect(store.get('a').pinned).toBe(true);
    });

    it('keeps a newer local field even when the server also returns the (older) row', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true, NOW + 10);
      // Server still shows the pre-write (unpinned) row, older clock.
      store.hydrate([['a', srv({ pinned: false, pinnedAt: NOW })]], new Map(), NOW + 10);
      expect(store.get('a').pinned).toBe(true);
    });

    it('adopts an independent newer server field while keeping the newer local one', () => {
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true, NOW); // local pin
      // Another device favorited a later (favorite is independent of pinned).
      store.hydrate(
        [['a', srv({ pinned: false, pinnedAt: NOW - 5, favorite: true, favoriteAt: NOW + 10 })]],
        new Map(),
        NOW + 10,
      );
      expect(store.get('a').pinned).toBe(true); // local pin newer than server's unpin
      expect(store.get('a').favorite).toBe(true); // independent newer server field adopted
    });

    it('keeps an undone dismissal through a hydrate carrying the still-dismissed server row', () => {
      // Pin, then sweep, then Undo — all before the undo's server write lands. A
      // focus resync then reads the still-swept server row. The undo restamps the
      // restored fields to its own clock, so per-field LWW keeps the restore (the
      // item stays pinned, not done) instead of re-applying the dismissal.
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true, NOW); // pin@NOW
      store.hideMany(['a'], NOW + 10); // sweep@NOW+10 (done=true, pin cleared)
      store.undoLast(NOW + 20); // undo@NOW+20 → restore the pin, restamped to NOW+20
      // The server still shows the swept row (the undo hasn't synced yet).
      const serverSwept = applyMutation(DEFAULT_ITEM_STATE, 'done', true, NOW + 10);
      store.hydrate([['a', serverSwept]], new Map([['a', {}]]), NOW + 20);
      expect(store.get('a', NOW + 20).pinned).toBe(true); // undo's clock beats the sweep
      expect(store.get('a', NOW + 20).done).toBe(false);
    });

    it('restamps undo exclusivity-cleared fields so a newer server hidden=true cannot re-clear the pin', () => {
      // Restoring a pin sends the closed write (hidden:false too). If the restamp
      // skipped `hidden` because its boolean was already false, a server row with a
      // newer hidden=true (legacy/stale source) would win LWW, and the hidden→Done
      // migration would clear the restored pin. Restamping the closed fields keeps
      // the pin.
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true, NOW);
      store.hideMany(['a'], NOW + 10); // sweep clears the pin
      store.undoLast(NOW + 20); // restore the pin; closed fields restamped to NOW+20
      // A legacy hidden=true server row, newer than the sweep but older than the undo.
      const serverHidden = applyMutation(DEFAULT_ITEM_STATE, 'hidden', true, NOW + 15);
      store.hydrate([['a', serverHidden]], new Map([['a', {}]]), NOW + 20);
      expect(store.get('a', NOW + 20).pinned).toBe(true); // not re-cleared by hidden→Done
      expect(store.get('a', NOW + 20).hidden).toBe(false);
      expect(store.get('a', NOW + 20).done).toBe(false);
    });

    it('adopts a strictly newer server value over a pending field (superseding cross-device write)', () => {
      // A pending write can be superseded by another device before the read
      // executes: ours drains and WINS mid-read, then a newer foreign write
      // lands, and the read returns the foreign value. No LWW-loss re-pull
      // fires for that ordering (our own send echoed a win), so the overlay
      // must not pin the stale local value — it exists to win ties and
      // null-clock upgrades, never a strictly newer server clock, which the
      // pending write would lose to server-side anyway.
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true, NOW); // local pin@NOW, still reported pending
      const serverUnpinned = applyMutation(
        state({ pinned: true, pinnedAt: NOW }),
        'pinned',
        false,
        NOW + 10,
      );
      store.hydrate([['a', serverUnpinned]], new Map([['a', { pinned: true }]]), NOW + 10);
      expect(store.get('a', NOW + 10).pinned).toBe(false); // newer foreign unpin wins
    });

    it('overlays a pending field on a clock TIE instead of reverting to the server', () => {
      // A queued write whose `at` equals the stale server row's clock (same-ms
      // toggle / reduced-precision timer). Strict-`>` LWW would treat the tie as
      // server truth and revert the optimistic value; the pending overlay keeps
      // local, matching the server's own `>=` when the write lands.
      const store = new ItemStateStore(memoryPersistence());
      store.set('a', 'pinned', true, NOW); // a prior pin synced at NOW
      store.set('a', 'pinned', false, NOW); // queued unpin, SAME ms → ties the server clock
      const serverPinned = state({ pinned: true, pinnedAt: NOW }); // stale pre-unpin row
      store.hydrate([['a', serverPinned]], new Map([['a', { pinned: false }]]), NOW);
      expect(store.get('a').pinned).toBe(false); // pending unpin not reverted by the tie
    });

    it('overlays a pending closed field whose clock persisted null (older-client upgrade)', () => {
      // An older client persisted the pin's exclusivity-cleared `done` with a null
      // clock, but the outbox entry carries the real action. A hydrate returning a
      // sibling server `done=true` would (clocks alone) adopt it while the overlay
      // kept the pin, leaving an invalid pinned+done row. Overlaying the pending
      // null-clock closed fields keeps local done=false. The pin itself, whose
      // clock IS comparable and strictly older than the server dismissal, is
      // adopted from the server (the pending pin loses the server's `>=` when it
      // lands, and the loss re-pull then converges the rest) — so no field pairing
      // is ever left invalid.
      let saved: Record<string, ItemState> = {
        a: state({ pinned: true, pinnedAt: NOW }), // doneAt defaults to null (old shape)
      };
      const store = new ItemStateStore({
        load: () => saved,
        save: (m) => {
          saved = m;
        },
      });
      const serverDone = applyMutation(DEFAULT_ITEM_STATE, 'done', true, NOW + 10);
      // The outbox still holds the pin's closed diff for 'a'.
      store.hydrate(
        [['a', serverDone]],
        new Map([['a', { pinned: true, done: false, hidden: false }]]),
        NOW + 10,
      );
      expect(store.get('a', NOW + 10).pinned).toBe(false); // newer server dismissal wins the comparable clock
      expect(store.get('a', NOW + 10).done).toBe(false); // null-clock closed field still overlaid — not left pinned+done
    });
  });
});
