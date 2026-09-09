import {
  DEFAULT_ITEM_STATE,
  TTL_MS,
  type ItemId,
  type ItemState,
  type ItemStateField,
} from '../types';
import type { ChangedFields } from './itemStateOutbox';

/** The five item-state boolean fields, each with its `<f>At` last-change clock. */
const ITEM_STATE_FIELDS: readonly ItemStateField[] = [
  'pinned',
  'favorite',
  'done',
  'hidden',
  'opened',
];

/**
 * Apply a single field mutation to an item's state, enforcing the
 * exclusivity rules from SPEC.md *Item state model → Enforcement at the
 * mutation layer*:
 *
 *  - pinning removes Done and Hidden (Pin is the active queue)
 *  - hiding removes Pinned
 *  - marking Done removes Pinned (Done is where items go when they leave
 *    the queue)
 *  - Favorite and Opened are independent of the others
 *
 * Pure and synchronous so it can be unit-tested directly and reused
 * verbatim by the server write path (the same rules live in the DB).
 * `now` is injectable for deterministic tests. Returns a NEW state object;
 * never mutates the input.
 */
export function applyMutation(
  prev: ItemState,
  field: ItemStateField,
  value: boolean,
  now: number = Date.now(),
): ItemState {
  const next: ItemState = { ...prev };
  // Stamp the action time on EVERY field this mutation touches — including the
  // exclusivity-cleared ones (a pin clears done+hidden) and a field set to
  // false. `<f>At` is each field's last-change clock, kept even while the flag is
  // false, exactly as the server stores it (migration 0023) and only ever read
  // while the flag is true (retention TTL, library sort, feed pin-order). Keeping
  // it lets `hydrate` reconcile per-field by last-write-wins against the server
  // read — and because the cleared fields share this `now`, the newest action's
  // fields all win together, so an LWW merge of two consistent rows stays
  // consistent (the same property the server's closed-diff LWW relies on).
  const stamp = (f: ItemStateField, on: boolean) => {
    next[f] = on;
    next[`${f}At` as const] = now;
  };

  stamp(field, value);

  if (value) {
    if (field === 'pinned') {
      stamp('done', false);
      stamp('hidden', false);
    } else if (field === 'hidden') {
      stamp('pinned', false);
    } else if (field === 'done') {
      stamp('pinned', false);
    }
  }

  return next;
}

/** True once a TTL'd field (done/hidden/opened) has aged past the retention
 * window (SPEC.md *Retention* — 30 days). */
function expired(at: number | null, now: number): boolean {
  return at !== null && now - at > TTL_MS;
}

/** Collapse expired Done/Hidden/Opened flags so retention is honored at read
 * time without a background sweep (SPEC.md *Retention*). Only Pinned and
 * Favorite are permanent; Done is a 30-day completion log, so it expires here
 * too (which auto-prunes `/done` and lets a long-dismissed item fall back to
 * its default — though by then it's also past the feed freshness window). */
export function withRetention(
  state: ItemState,
  now: number = Date.now(),
): ItemState {
  let next = state;
  if (state.done && expired(state.doneAt, now)) {
    next = { ...next, done: false, doneAt: null };
  }
  if (state.hidden && expired(state.hiddenAt, now)) {
    next = { ...next, hidden: false, hiddenAt: null };
  }
  if (state.opened && expired(state.openedAt, now)) {
    next = { ...next, opened: false, openedAt: null };
  }
  return next;
}

/**
 * Reconcile a local row against the authoritative server row by **per-field
 * last-write-wins** on each field's `<f>At` clock — the same rule the server's
 * `set_item_state` applies (migration 0023). For each field, keep the local
 * value only when its last-change time is strictly newer than the server's;
 * otherwise adopt the server (so an un-acted field — both clocks null/0 — takes
 * server truth, and a clock tie adopts the server here — a tie that is still an
 * un-synced local write is handled by the pending overlay in `hydrate`, which
 * matches the server's own `>=` tie bias). Because a mutation stamps every field
 * it touches (the action field AND the exclusivity-cleared ones) with the same
 * `now`, the newest action's fields all win together, so merging two
 * individually-consistent rows stays consistent without re-deriving
 * pin/done/hidden exclusivity here.
 */
function mergeByLww(srv: ItemState, local: ItemState): ItemState {
  const next: ItemState = { ...srv };
  for (const f of ITEM_STATE_FIELDS) {
    const fAt = `${f}At` as const;
    if ((local[fAt] ?? 0) > (srv[fAt] ?? 0)) {
      next[f] = local[f];
      next[fAt] = local[fAt];
    }
  }
  return next;
}

/** Whether two states carry the same boolean flags (clocks ignored). */
function sameFlags(a: ItemState, b: ItemState): boolean {
  return ITEM_STATE_FIELDS.every((f) => a[f] === b[f]);
}

/** Structural equality of two item states (all flags + timestamps + version). */
function sameState(a: ItemState, b: ItemState): boolean {
  return (
    a.pinned === b.pinned &&
    a.pinnedAt === b.pinnedAt &&
    a.favorite === b.favorite &&
    a.favoriteAt === b.favoriteAt &&
    a.done === b.done &&
    a.doneAt === b.doneAt &&
    a.hidden === b.hidden &&
    a.hiddenAt === b.hiddenAt &&
    a.opened === b.opened &&
    a.openedAt === b.openedAt
  );
}

/** Whether two state maps are structurally identical (so hydrate can skip a
 * no-op persist/emit). */
function sameMap(
  a: Record<ItemId, ItemState>,
  b: Record<ItemId, ItemState>,
): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    const bv = b[k];
    if (!bv || !sameState(a[k], bv)) return false;
  }
  return true;
}

export type StateListener = () => void;

/** Notified only on *user-driven* mutations (set / hide / sweep / undo) with the
 * changed-field diff — never on hydration or cross-device sync, which reconcile
 * via {@link ItemStateStore.hydrate} and emit no diff. Lets a subscriber react
 * to "the user just pinned this" without mistaking a background server pin for
 * one (see ItemList's in-session pin tracking). */
export type MutationListener = (
  id: ItemId,
  changed: Partial<Record<ItemStateField, boolean>>,
) => void;

/** Pluggable persistence for the state map. The mock uses localStorage; a
 * future Supabase-backed store swaps the implementation while the store API
 * (and every UI hook above it) stays identical. */
export interface StatePersistence {
  load(): Record<ItemId, ItemState>;
  save(map: Record<ItemId, ItemState>): void;
}

/**
 * Client-side mirror of item_state. Holds the optimistic local copy, applies
 * mutations through `applyMutation`, persists via the injected backend, and
 * notifies subscribers so React hooks re-render. The same store shape will
 * back the offline outbox in PR2.
 */
/** A snapshot of prior states for one undoable batch (hide / swipe / sweep).
 * Undo restores exactly these entries. */
type UndoBatch = Array<[ItemId, ItemState | null]>;

export class ItemStateStore {
  private map: Record<ItemId, ItemState>;
  private listeners = new Set<StateListener>();
  private mutationListeners = new Set<MutationListener>();
  private syncedListeners = new Set<() => void>();
  private hydratedListeners = new Set<() => void>();
  // Per-id cache of the retention-applied snapshot so `get()` returns a
  // referentially-stable object between store changes. Without this, an item
  // whose Hidden/Opened flag has aged past the TTL would yield a fresh object
  // on every `get()` (withRetention clones), and since `get()` is the
  // useSyncExternalStore snapshot, React would warn about an unstable snapshot
  // and could re-render in a loop. Keyed on the raw stored object identity
  // (changes only on a real mutation) AND a `validUntil` deadline — the next
  // TTL boundary at which the retained snapshot would change — so a session
  // left open past the retention TTL still re-includes expired rows.
  private retainedCache = new Map<
    ItemId,
    { raw: ItemState; out: ItemState; validUntil: number }
  >();
  // One level of undo, matching newshacker's "restore the last hide / swipe /
  // sweep batch" (SPEC.md *List toolbar*). Only hide-style mutations record
  // here; pin/favorite/done toggles are not toolbar-undoable.
  private lastUndo: UndoBatch | null = null;
  // Identity of the action that produced `lastUndo`. `hideMany` only *extends*
  // the existing batch when the caller passes the SAME key — so a stream of
  // auto-hide-on-scroll dismissals (one stable key for the burst) accumulates,
  // but any intervening keyless dismissal (swipe / Sweep) replaces the batch and
  // can't be re-extended by a later scroll hide. null = no extendable batch.
  private lastUndoKey: string | number | null = null;
  // Optional write-through: invoked with the set of boolean fields a mutation
  // actually CHANGED (prev→next diff) plus the action timestamp `at`, so a
  // backing data source can persist just those (SupabaseDataSource routes this to
  // the set_item_state RPC). Sending the diff — not the full state — means
  // exclusivity-cleared fields (e.g. pin clearing done/hidden) and undo's restored
  // fields ARE sent, while independent fields untouched by this action (e.g.
  // favorite) are left alone. `at` is the per-field last-write-wins clock the
  // server compares, so a stale write can't clobber a newer change made elsewhere.
  // The local map stays the optimistic mirror; the mock leaves this unset.
  private sink:
    | ((
        id: ItemId,
        changed: Partial<Record<ItemStateField, boolean>>,
        at: number,
      ) => void)
    | null = null;

  constructor(private persistence: StatePersistence) {
    const loaded = persistence.load();
    // Migrate pre-merge hidden rows: any item that was dismissed via the old
    // hidden path (hidden=true, done=false) gets done=true so it surfaces in
    // the Done library instead of being invisible with no recovery path.
    let migrated = false;
    const now = Date.now();
    const map: typeof loaded = {};
    for (const [id, state] of Object.entries(loaded)) {
      if (state.hidden && !state.done && !expired(state.hiddenAt, now)) {
        // Skip rows whose hiddenAt is already past the TTL — they would have
        // expired and reappeared anyway; don't resurrect them as fresh Done.
        // Clear hidden so "Unmark done" / "Forget all" on the Done page leaves
        // the item fully visible again rather than re-hiding it — and stamp the
        // clear with `now` (the same clock rule as applyMutation), NOT null. The
        // migration never writes back to the server, so the server row keeps
        // hidden=true with its old clock; a nulled local clock would lose the
        // next hydrate's per-field LWW and resurrect hidden=true alongside the
        // migrated Done (and "Unmark done" would then strand the item invisible).
        map[id] = {
          ...applyMutation(state, 'done', true, now),
          hidden: false,
          hiddenAt: now,
        };
        migrated = true;
      } else {
        map[id] = state;
      }
    }
    this.map = map;
    if (migrated) persistence.save(this.map);
  }

  /** Register a write-through sink invoked with the changed-field diff of a
   * mutation (see `sink`). Hydration does NOT fire it — only user-driven
   * set/hide/undo mutations do. */
  setMutationSink(
    sink: (
      id: ItemId,
      changed: Partial<Record<ItemStateField, boolean>>,
      at: number,
    ) => void,
  ): void {
    this.sink = sink;
  }

  /** Fields whose boolean value differs between two states, with their `to`
   * values — the minimal write that moves `from` to `to`. `at` is the action
   * time (the last-write-wins clock the sink forwards to the server). */
  private emitDiff(id: ItemId, from: ItemState, to: ItemState, at: number): void {
    if (!this.sink && this.mutationListeners.size === 0) return;
    const fields: ItemStateField[] = ['pinned', 'favorite', 'done', 'hidden', 'opened'];
    const changed: Partial<Record<ItemStateField, boolean>> = {};
    for (const f of fields) if (from[f] !== to[f]) changed[f] = to[f];
    if (Object.keys(changed).length === 0) return;
    // The server sink gets the EXCLUSIVITY-CLOSED diff: when an action turns
    // pinned/done/hidden on, always carry the fields it clears (done+hidden for a
    // Pin; pinned for a Done/Hide) even if they were ALREADY false in the local
    // mirror. The mirror can be stale — another device may have set the cleared
    // field server-side and this tab hasn't hydrated it — so a natural diff would
    // omit p_done, and per-field LWW would leave an invalid pinned+done row on the
    // server. Closing over the action's own exclusivity keeps every server write
    // self-consistent regardless of local-mirror staleness. (The local mutation
    // listeners get the natural diff — what changed for this user on this device.)
    if (this.sink) {
      const closed: Partial<Record<ItemStateField, boolean>> = { ...changed };
      if (to.pinned && !from.pinned) {
        closed.done = false;
        closed.hidden = false;
      }
      if (to.done && !from.done) closed.pinned = false;
      if (to.hidden && !from.hidden) closed.pinned = false;
      this.sink(id, closed, at);
    }
    for (const l of this.mutationListeners) l(id, changed);
  }

  get(id: ItemId, now: number = Date.now()): ItemState {
    const raw = this.map[id];
    if (!raw) return DEFAULT_ITEM_STATE;
    const cached = this.retainedCache.get(id);
    if (cached && cached.raw === raw && now < cached.validUntil) {
      return cached.out;
    }
    const out = withRetention(raw, now);
    // The retained snapshot only changes again when an as-yet-unexpired
    // Done/Hidden/Opened flag crosses its TTL boundary; cache until the earliest
    // such boundary (else forever). This keeps repeated reads referentially
    // stable while never pinning a stale pre-expiry snapshot indefinitely.
    let validUntil = Number.POSITIVE_INFINITY;
    if (out.done && raw.doneAt !== null) {
      validUntil = Math.min(validUntil, raw.doneAt + TTL_MS);
    }
    if (out.hidden && raw.hiddenAt !== null) {
      validUntil = Math.min(validUntil, raw.hiddenAt + TTL_MS);
    }
    if (out.opened && raw.openedAt !== null) {
      validUntil = Math.min(validUntil, raw.openedAt + TTL_MS);
    }
    this.retainedCache.set(id, { raw, out, validUntil });
    return out;
  }

  /** Whether the store holds any item-state rows at all (cheap — ignores
   * retention, so an all-expired map still reads as non-empty). Lets a feed/
   * library read tell "we have last-good state to overlay" from "brand-new
   * device, nothing to show yet": the former returns rows immediately and lets
   * hydration refresh in the background; only the latter waits on the first
   * hydration. */
  hasEntries(): boolean {
    for (const _id in this.map) return true;
    return false;
  }

  /** All non-default, non-expired states keyed by id. */
  entries(now: number = Date.now()): Array<[ItemId, ItemState]> {
    return Object.entries(this.map).map(
      ([id, s]) => [id, withRetention(s, now)] as [ItemId, ItemState],
    );
  }

  /**
   * Reconcile the local store against the authoritative server `item_state`
   * rows by **per-field last-write-wins** ({@link mergeByLww}): each field takes
   * whichever of {local, server} has the newer `<f>At` clock. An un-synced or
   * just-made local write carries a newer clock than the (possibly pre-write)
   * server snapshot, so it survives, while an independent field another device
   * changed has a newer server clock and is adopted. A stale local write that
   * LOST server-side is corrected when the failure re-pull (`lwwLossPending` /
   * `onPermanentReject`) reads the winner's newer clock.
   *
   * `pending` (the outbox's changed-fields per item) covers what LWW clocks
   * alone can't decide:
   *  - **Field overlay.** A field with an un-synced write keeps its LOCAL value
   *    unless the server clock is strictly newer — the write hasn't reached the
   *    server, so the read can't reflect it, and it will win the server's `>=`
   *    when it lands. This wins ms-`at` ties (a strict `>` would wrongly drop
   *    the optimistic value) and rows upgraded from an older client whose
   *    exclusivity-cleared false fields persisted with a `null` clock. A
   *    strictly NEWER server clock is a cross-device write the pending one will
   *    lose to, so the server value is adopted (see the overlay note below).
   *  - **Absent-row protection.** A local row the server didn't return is kept
   *    only when it has a pending write (a brand-new row whose write hasn't
   *    reached the server, or raced this read); otherwise it's genuinely gone
   *    (lost visibility / reset elsewhere) and dropped.
   *
   * Persists + notifies once if anything changed. Used by SupabaseDataSource.
   */
  hydrate(
    rows: Array<[ItemId, ItemState]>,
    pending: ReadonlyMap<ItemId, ChangedFields> = new Map(),
    now: number = Date.now(),
    /** `partial: true` when `rows` is an INCREMENTAL read (everything changed
     * since a cursor) rather than the caller's complete set. Absent then means
     * "unchanged since the cursor", not "gone", so the drop pass below is
     * skipped and every local row survives. Getting this wrong in either
     * direction is silent data loss, so it is an explicit flag rather than
     * anything inferred from the row count. */
    opts: { partial?: boolean } = {},
  ): void {
    const serverIds = new Set(rows.map(([id]) => id));
    const next: Record<ItemId, ItemState> = {};
    for (const [id, srv] of rows) {
      const local = this.map[id];
      let merged = local ? mergeByLww(srv, local) : srv;
      // Overlay the still-pending fields onto the LWW result, taking the local
      // value+clock so an un-synced write isn't reverted by a clock tie or a
      // pre-write/sibling server field (see the `pending` note above). The
      // overlay exists to win same-ms ties and null-local-clock upgrades ONLY —
      // never a strictly newer server clock: that's a cross-device write this
      // read already reflects and the pending write will LOSE the server's `>=`
      // when it lands (e.g. a write that drained-and-won mid-read, then was
      // superseded by another device before the read executed — no loss re-pull
      // fires for that ordering, so adopting the server here is the only
      // correction). A null local clock still overlays: a current client stamps
      // every field it touches, so null means a legacy row whose pending write
      // carries its own `at` and resolves server-side.
      const changed = local && pending.get(id);
      if (changed) {
        const overlaid: ItemState = { ...merged };
        for (const f of Object.keys(changed) as ItemStateField[]) {
          const fAt = `${f}At` as const;
          if (local[fAt] !== null && (local[fAt] as number) < (overlaid[fAt] ?? 0)) {
            continue; // server clock strictly newer — the local write already lost
          }
          overlaid[f] = local[f];
          overlaid[fAt] = local[fAt];
        }
        merged = overlaid;
      }
      // Migrate pre-merge hidden rows that arrive from the server: same logic
      // as the constructor migration so Supabase-hydrated hidden=true/done=false
      // rows don't stay invisible with /hidden removed. As there, the hidden
      // clear is stamped with `now` — the migration is local-only (hydrate never
      // fires the sink), so the server row keeps hidden=true with its old clock,
      // and only a newer local clock keeps the next hydrate's LWW from
      // resurrecting it.
      if (merged.hidden && !merged.done && !expired(merged.hiddenAt, now)) {
        next[id] = {
          ...applyMutation(merged, 'done', true, now),
          hidden: false,
          hiddenAt: now,
        };
      } else {
        next[id] = merged;
      }
    }
    // Keep a local-only row (absent from the server) only while it has a pending
    // write; otherwise it's genuinely gone. On a PARTIAL read there is no such
    // signal to read — the query asked only for rows past a cursor, so every
    // untouched row is legitimately missing — and dropping them would wipe the
    // entire library on the first incremental pull.
    for (const id of Object.keys(this.map)) {
      if (serverIds.has(id)) continue;
      if (opts.partial || pending.has(id)) next[id] = this.map[id];
    }
    if (sameMap(this.map, next)) return;
    this.map = next;
    // A cross-device RESTORE invalidates that row's entry in the pending undo
    // batch. `undoLast` replays each entry's pre-hide snapshot verbatim, so a
    // row another device revived would let a later batch Undo stomp whatever
    // happened to it since — unpinning a row the reader pinned after the
    // restore. Only a restore drops its entry: a hydrate that merely echoes our
    // own dismissal back (the outbox round-trip) leaves the row dismissed and
    // must NOT, or syncing would silently retract the Undo the reader just
    // earned.
    if (this.lastUndo) {
      for (const [id] of [...this.lastUndo]) {
        const st = next[id];
        if (st && !st.done && !st.hidden) this.invalidateUndoEntry(id);
      }
    }
    this.persistence.save(this.map);
    this.emit();
    // Distinct from `emit()`: fires only when a hydrate/cross-device sync
    // actually changed the map (never on a local mutation, and never on a no-op
    // hydrate). Feed-items queries subscribe to THIS — a local triage mutation
    // reflects through the store overlay with no refetch, but a cross-device
    // change can add/reorder rows the overlay can't express (e.g. a pin of an
    // article not in the loaded window), so the feed must reconcile with the
    // server. See useFeedInvalidation.
    for (const l of this.hydratedListeners) l();
  }

  set(
    id: ItemId,
    field: ItemStateField,
    value: boolean,
    now: number = Date.now(),
  ): ItemState {
    // Mutate from the retention-effective state, not the raw stored row. A TTL'd
    // flag (done/hidden/opened) past its window reads as cleared, so an action
    // on the collapsed value — e.g. re-dismissing an item whose Done expired and
    // re-entered the freshness window — must register as a real false→true
    // transition: applyMutation re-stamps the timestamp and emitDiff fires the
    // sink. Basing `prev` on the raw (still-true) row would make it a no-op and
    // leave the server's expired done_at un-refreshed.
    const prev = withRetention(this.map[id] ?? DEFAULT_ITEM_STATE, now);
    const next = applyMutation(prev, field, value, now);
    // Value-unchanged actions need care: applyMutation restamps `<f>At = now`,
    // but emitDiff sends no server write when no boolean changed, and storing
    // a restamped clock with no matching server write leaves the local clock
    // permanently ahead with nothing pending — hydrate's LWW would forever
    // prefer the stale local value over a legitimate cross-device write (e.g.
    // another device's "mark unread"). So a value-unchanged write either goes
    // ALL the way through (restamp + server write) or not at all:
    //  - Re-asserting a still-true TTL'd flag — the everyday case is
    //    re-opening an already-opened article — is a real recency refresh:
    //    /opened is the 30-day recently-opened history, so the clock restamps
    //    AND the write reaches the server, keeping both clocks in step and
    //    the retention window anchored to the LATEST open, not the first.
    //  - Everything else (re-asserting Pinned/Favorite, setting an
    //    already-false flag false) is a full no-op.
    if (sameFlags(prev, next)) {
      const refreshesTtl =
        value && (field === 'done' || field === 'hidden' || field === 'opened');
      if (!refreshesTtl) return prev;
      this.map = { ...this.map, [id]: next };
      this.persistence.save(this.map);
      // Mirror emitDiff's exclusivity closure for the server write (a Done/
      // Hide re-assert still carries pinned:false so a stale cross-device pin
      // can't leave an invalid pinned+done row). The local mutation listeners
      // stay silent — nothing changed for this user on this device.
      if (this.sink) {
        const closed: Partial<Record<ItemStateField, boolean>> = {
          [field]: true,
        };
        if (field === 'done' || field === 'hidden') closed.pinned = false;
        this.sink(id, closed, now);
      }
      this.emit();
      return next;
    }
    this.map = { ...this.map, [id]: next };
    // Undo may restore dismissal state; it must NEVER revert a pin or a
    // favorite. `undoLast` replays each batch entry's pre-hide snapshot
    // verbatim, so a row that is pinned or favorited AFTER its hide would have
    // that stripped when the reader undoes the rest of the burst. Strike mode
    // makes this ordinary — a struck row stays on screen and fully tappable, so
    // pinning one is a normal thing to do — but the hazard is not specific to
    // any one route in (the row menu, the reader, a keyboard shortcut), so the
    // rule lives here, at the mutation itself, rather than at each caller.
    //
    // ONLY `pinned`. `favorite` and `opened` are already safe — undoLast restores
    // just the dismissal fields and carries those forward untouched. A pin is
    // different because it IS a decision about the dismissal state (it clears
    // Done), so an Undo would legitimately-but-wrongly revert it; the row leaves
    // the batch instead. Dropping entries for done/hidden/opened would shrink a
    // burst's Undo every time the reader merely opened a struck row.
    if (field === 'pinned') {
      this.invalidateUndoEntry(id);
    }
    this.persistence.save(this.map);
    this.emitDiff(id, prev, next, now);
    this.emit();
    return next;
  }

  /** Remove one id from the pending undo batch, clearing the batch when it was
   * the last entry. Pure bookkeeping — no restore, no emit; callers emit as
   * part of whatever change prompted it. */
  private invalidateUndoEntry(id: ItemId): boolean {
    const batch = this.lastUndo;
    if (!batch) return false;
    const kept = batch.filter(([bid]) => bid !== id);
    if (kept.length === batch.length) return false;
    if (kept.length === 0) {
      this.lastUndo = null;
      this.lastUndoKey = null;
    } else {
      this.lastUndo = kept;
    }
    return true;
  }

  /** Dismiss one item (marks done, records an undo point). Distinct from
   * `set(id, 'done', true)` which is not undoable. Used for swipe-right. */
  hide(id: ItemId, now: number = Date.now()): void {
    this.hideMany([id], now);
  }

  /** Sweep: dismiss many items as done in a single undoable batch. No-op
   * when `ids` is empty.
   *
   * `batchKey` lets a stream of dismissals accumulate into one undoable batch:
   * when it matches the key of the current `lastUndo`, the new ids are appended
   * instead of replacing it — so an auto-hide-on-scroll burst (one stable key
   * for the burst, see ItemList) restores as a single Undo. A keyless call
   * (swipe / Sweep) always starts a fresh batch and clears the key, so an
   * intervening manual dismissal can't be bundled into a later scroll burst.
   * Ids already in the batch keep their *original* prior state, so a re-delivered
   * id can't overwrite the real pre-hide snapshot with the already-Done state. */
  hideMany(
    ids: ItemId[],
    now: number = Date.now(),
    { batchKey }: { batchKey?: string | number } = {},
  ): void {
    if (ids.length === 0) return;
    const extend =
      batchKey != null && batchKey === this.lastUndoKey && this.lastUndo != null;
    const base: UndoBatch = extend ? (this.lastUndo as UndoBatch) : [];
    const seen = new Set(base.map(([id]) => id));
    const batch: UndoBatch = base;
    for (const id of ids) {
      const raw = this.map[id];
      // Effective (retention-applied) state is the mutation baseline AND the
      // undo snapshot, so re-dismissing an expired-Done item emits the sink
      // (false→true) and Undo reverts it on the server too (true→false). See
      // the note in `set`.
      const prev = withRetention(raw ?? DEFAULT_ITEM_STATE, now);
      if (!seen.has(id)) {
        batch.push([id, raw ? prev : null]);
        seen.add(id);
      }
      const next = applyMutation(prev, 'done', true, now);
      // Same value-unchanged guard as `set`: an already-Done id (e.g. one
      // re-delivered across bursts) must not restamp its local clocks with no
      // matching server write, or the restamped clock wins hydrate's LWW over
      // later cross-device writes. The undo snapshot above is still recorded —
      // restoring an unchanged state is itself a no-op.
      if (sameFlags(prev, next)) continue;
      this.map = { ...this.map, [id]: next };
      this.emitDiff(id, prev, next, now);
    }
    this.lastUndo = batch;
    this.lastUndoKey = batchKey ?? null;
    this.persistence.save(this.map);
    this.emit();
  }

  canUndo(): boolean {
    return this.lastUndo !== null;
  }

  /** Drop one id from the pending undo batch, without restoring anything.
   *
   * For a row the reader has ALREADY restored individually (the per-row Undo on
   * a dismissed-in-place row). `undoLast` writes each batch entry's pre-hide
   * snapshot back verbatim, so leaving a rescued row in the batch means a later
   * batch Undo reverts whatever the reader did to it after the rescue — pin it,
   * favorite it, and the toolbar Undo silently undoes that too. An explicit
   * per-row restore is the newer action and takes the row out of the batch.
   *
   * Clears the batch entirely once its last id is consumed, so `canUndo()` stops
   * offering an Undo that would do nothing. */
  dropFromUndo(id: ItemId): void {
    // The undo AVAILABILITY changed (the toolbar button reads canUndo), so the
    // subscribers need a repaint even though no item state moved.
    if (this.invalidateUndoEntry(id)) this.emit();
  }

  /** Restore the most recent hide/sweep batch. Returns the ids it restored
   * (in batch order), so a caller can react to the restore — e.g. scroll the
   * list back up to the topmost row that just reappeared. Empty when there was
   * nothing to undo. */
  undoLast(now: number = Date.now()): ItemId[] {
    const batch = this.lastUndo;
    if (!batch) return [];
    const next = { ...this.map };
    // Emit the diff from the current (hidden) state back to the restored prior
    // BEFORE reassigning the map — restoring re-sends whatever hiding changed
    // (hidden, plus any Pinned/Done it cleared), so the server doesn't keep them
    // cleared and drop the restored pin on the next hydrate. Untouched fields
    // aren't sent. The restore is a fresh action, so it carries `now` as its
    // last-write-wins clock and wins over the dismissal it reverses.
    for (const [id, prior] of batch) {
      const current = this.map[id] ?? DEFAULT_ITEM_STATE;
      const snapshot = prior ?? DEFAULT_ITEM_STATE;
      // Undo reverts the DISMISSAL, not the row's whole history. A hide only
      // ever touches pinned/done/hidden (applyMutation's exclusivity rules), so
      // those are the only fields restored from the snapshot. `favorite` and
      // `opened` are independent of dismissal and carry forward at their CURRENT
      // values — replaying the snapshot wholesale would revert whatever the
      // reader did to the row after the hide, and for `opened` that means
      // emitting opened:false and dropping an article out of /opened that they
      // had just read. Strike mode makes that ordinary (a struck row stays on
      // screen and openable), but the bug was always latent for swipe/Sweep.
      const restored: ItemState = {
        ...current,
        pinned: snapshot.pinned,
        pinnedAt: snapshot.pinnedAt,
        done: snapshot.done,
        doneAt: snapshot.doneAt,
        hidden: snapshot.hidden,
        hiddenAt: snapshot.hiddenAt,
      };
      this.emitDiff(id, current, restored, now);
      // Restamp the reverted fields' `<f>At` to `now` so the local restore carries
      // the SAME last-write-wins clock the server write does. Writing the prior
      // snapshot back with its pre-hide clocks would let a hydrate landing before
      // the undo syncs compare those (older) clocks against the server's newer
      // dismissal clocks and re-apply the dismissal. A brand-new item (prior null,
      // restored to DEFAULT) keeps its now-stamped row rather than being deleted,
      // for the same reason — else the server's still-dismissed row would win LWW
      // until the undo lands.
      //
      // Restamp EXACTLY the fields the server write carries — the
      // exclusivity-CLOSED diff (mirrors emitDiff): the changed booleans PLUS the
      // fields the restored action clears, even when their local boolean was
      // already false. Otherwise restoring a pin leaves `hidden`'s clock stale, and
      // a server row with a newer hidden=true would win LWW and re-clear the pin.
      const next_id: ItemState = { ...restored };
      const restamp = new Set<ItemStateField>();
      for (const f of ITEM_STATE_FIELDS) {
        if (current[f] !== restored[f]) restamp.add(f);
      }
      if (restored.pinned && !current.pinned) {
        restamp.add('done');
        restamp.add('hidden');
      }
      if (restored.done && !current.done) restamp.add('pinned');
      if (restored.hidden && !current.hidden) restamp.add('pinned');
      for (const f of restamp) next_id[`${f}At` as const] = now;
      next[id] = next_id;
    }
    this.map = next;
    this.lastUndo = null;
    this.lastUndoKey = null;
    this.persistence.save(this.map);
    this.emit();
    return batch.map(([id]) => id);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to user-driven mutations only (see {@link MutationListener}).
   * Fires with the changed-field diff on every set/hide/sweep/undo; never on
   * hydration or cross-device sync. */
  subscribeMutations(listener: MutationListener): () => void {
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  /** Subscribe to outbox drains specifically — fired by {@link notifySynced}
   * when a queued write commits server-side, and never by a local mutation or
   * hydration. Lets a consumer that issued a refetch racing the async write
   * (notably Undo, which must resurface a row the server still reports dismissed)
   * re-fetch once server truth actually reflects the write. */
  subscribeSynced(listener: () => void): () => void {
    this.syncedListeners.add(listener);
    return () => {
      this.syncedListeners.delete(listener);
    };
  }

  /** Subscribe to hydrations that changed the map — a boot restore or a
   * cross-device resync ({@link hydrate}), never a local set/hide/sweep/undo,
   * a no-op hydrate, or an outbox drain. Lets the feed-items queries refetch to
   * pull in server-side row changes the local overlay can't express, while a
   * local triage mutation is left to settle from the overlay alone. */
  subscribeHydrated(listener: () => void): () => void {
    this.hydratedListeners.add(listener);
    return () => {
      this.hydratedListeners.delete(listener);
    };
  }

  /** Notify subscribers without a local state change. Used by the durable outbox
   * after a write commits server-side: the local store is unchanged, but
   * subscribers that derive from *server* reads — notably the per-feed
   * unread-count query, which refetches on feed invalidation — must re-validate
   * now that the server reflects the just-synced write. Without this, that query
   * would keep the count it refetched optimistically (before the write landed)
   * cached for the stale window. Also wakes {@link subscribeSynced} listeners. */
  notifySynced(): void {
    for (const l of this.syncedListeners) l();
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** localStorage-backed persistence used by the mock data source. Tolerates
 * quota/privacy-mode failures by degrading to in-memory (reads return {}). */
export function localStoragePersistence(key: string): StatePersistence {
  const hasWindow = typeof window !== 'undefined';
  return {
    load() {
      if (!hasWindow) return {};
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null) return {};
        return parsed as Record<ItemId, ItemState>;
      } catch {
        return {};
      }
    },
    save(map) {
      if (!hasWindow) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(map));
      } catch {
        // quota / privacy-mode failures are non-fatal
      }
    },
  };
}
