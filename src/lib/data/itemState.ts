import {
  DEFAULT_ITEM_STATE,
  TTL_MS,
  type ItemId,
  type ItemState,
  type ItemStateField,
} from '../types';
import type { ChangedFields } from './itemStateOutbox';

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
  const stamp = (f: ItemStateField, on: boolean) => {
    next[f] = on;
    next[`${f}At` as const] = on ? now : null;
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

  next.version = prev.version + 1;
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
 * Overlay only the *pending* (un-synced) fields onto the authoritative server
 * row, so a hydrate adopts independent fields another device changed while still
 * preserving the local optimistic write that hasn't reached the server yet.
 * Prefers the local snapshot's values (real action timestamps); falls back to
 * re-applying the queued field changes when there's no local mirror. Stays
 * consistent with the exclusivity rules because the outbox's changed-set is
 * itself closed under them (a Pin diff carries the cleared Done/Hidden too).
 */
function mergePending(
  srv: ItemState,
  local: ItemState | undefined,
  changed: ChangedFields,
  now: number,
): ItemState {
  if (local) {
    const next: ItemState = {
      ...srv,
      version: Math.max(srv.version, local.version),
    };
    for (const f of Object.keys(changed) as ItemStateField[]) {
      next[f] = local[f];
      next[`${f}At` as const] = local[`${f}At` as const];
    }
    return next;
  }
  let next = srv;
  for (const [f, v] of Object.entries(changed)) {
    next = applyMutation(next, f as ItemStateField, v as boolean, now);
  }
  return next;
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
    a.openedAt === b.openedAt &&
    a.version === b.version
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
  // actually CHANGED (prev→next diff), so a backing data source can persist just
  // those (SupabaseDataSource routes this to the set_item_state RPC). Sending the
  // diff — not the full state — means exclusivity-cleared fields (e.g. pin
  // clearing done/hidden) and undo's restored fields ARE sent, while independent
  // fields untouched by this action (e.g. favorite) are left alone, so a stale
  // local mirror can't clobber a concurrent change made elsewhere. The local map
  // stays the optimistic mirror; the mock leaves this unset.
  private sink:
    | ((id: ItemId, changed: Partial<Record<ItemStateField, boolean>>) => void)
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
        // Also clear hidden/hiddenAt so "Unmark done" / "Forget all" on the
        // Done page leaves the item fully visible again rather than re-hiding it.
        // Preserve the row's existing version: this migration is a local
        // representation change that never wrote the server, so it must NOT
        // advance the version. applyMutation bumps it +1; keeping that bump would
        // make `seedConfirmedVersions` seed an inflated optimistic-concurrency
        // base that the live hydrate's real (lower) server version can't correct
        // (monotonic merge), 40001-conflicting the next edit. (Cf.
        // confirmServerVersion for the coalesced-write counterpart.)
        map[id] = {
          ...applyMutation(state, 'done', true, now),
          hidden: false,
          hiddenAt: null,
          version: state.version,
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
    sink: (id: ItemId, changed: Partial<Record<ItemStateField, boolean>>) => void,
  ): void {
    this.sink = sink;
  }

  /** Fields whose boolean value differs between two states, with their `to`
   * values — the minimal write that moves `from` to `to`. */
  private emitDiff(id: ItemId, from: ItemState, to: ItemState): void {
    if (!this.sink) return;
    const fields: ItemStateField[] = ['pinned', 'favorite', 'done', 'hidden', 'opened'];
    const changed: Partial<Record<ItemStateField, boolean>> = {};
    for (const f of fields) if (from[f] !== to[f]) changed[f] = to[f];
    if (Object.keys(changed).length > 0) this.sink(id, changed);
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
   * rows. The server is the source of truth field-by-field, EXCEPT for the
   * specific fields with an un-synced pending write (`pending`, the outbox's
   * changed-fields per item): those keep their optimistic local value so a
   * hydrate that races an in-flight write neither wipes the user's change nor
   * masks an independent field another device changed. Local rows the server
   * didn't return AND that aren't pending are genuinely stale (the item_state
   * row was reset/expired elsewhere) and are dropped — the pending guard is what
   * makes that clearing safe (no data-loss race). Persists + notifies once if
   * anything changed. Used by SupabaseDataSource after fetching the caller's rows.
   */
  hydrate(
    rows: Array<[ItemId, ItemState]>,
    pending: ReadonlyMap<ItemId, ChangedFields> = new Map(),
    now: number = Date.now(),
  ): void {
    const serverIds = new Set(rows.map(([id]) => id));
    const next: Record<ItemId, ItemState> = {};
    // Server rows win unless the item has a pending local write — then overlay
    // just the pending fields onto server truth.
    for (const [id, srv] of rows) {
      const changed = pending.get(id);
      const merged = changed ? mergePending(srv, this.map[id], changed, now) : srv;
      // Migrate pre-merge hidden rows that arrive from the server: same logic
      // as the constructor migration so Supabase-hydrated hidden=true/done=false
      // rows don't stay invisible with /hidden removed. Keep the (server-derived)
      // version rather than applyMutation's +1, so a migrated row never seeds an
      // inflated optimistic-concurrency base — see the constructor migration.
      if (merged.hidden && !merged.done && !expired(merged.hiddenAt, now)) {
        next[id] = {
          ...applyMutation(merged, 'done', true, now),
          hidden: false,
          hiddenAt: null,
          version: merged.version,
        };
      } else {
        next[id] = merged;
      }
    }
    // Keep local-only rows only while a write for them is still pending.
    for (const id of Object.keys(this.map)) {
      if (!serverIds.has(id) && pending.has(id)) next[id] = this.map[id];
    }
    if (sameMap(this.map, next)) return;
    this.map = next;
    this.persistence.save(this.map);
    this.emit();
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
    this.map = { ...this.map, [id]: next };
    this.persistence.save(this.map);
    this.emitDiff(id, prev, next);
    this.emit();
    return next;
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
      this.map = { ...this.map, [id]: next };
      this.emitDiff(id, prev, next);
    }
    this.lastUndo = batch;
    this.lastUndoKey = batchKey ?? null;
    this.persistence.save(this.map);
    this.emit();
  }

  canUndo(): boolean {
    return this.lastUndo !== null;
  }

  /** Restore the most recent hide/sweep batch. */
  undoLast(): void {
    const batch = this.lastUndo;
    if (!batch) return;
    const next = { ...this.map };
    // Emit the diff from the current (hidden) state back to the restored prior
    // BEFORE reassigning the map — restoring re-sends whatever hiding changed
    // (hidden, plus any Pinned/Done it cleared), so the server doesn't keep them
    // cleared and drop the restored pin on the next hydrate. Untouched fields
    // aren't sent.
    for (const [id, prior] of batch) {
      this.emitDiff(id, this.map[id] ?? DEFAULT_ITEM_STATE, prior ?? DEFAULT_ITEM_STATE);
    }
    for (const [id, prior] of batch) {
      if (prior === null) delete next[id];
      else next[id] = prior;
    }
    this.map = next;
    this.lastUndo = null;
    this.lastUndoKey = null;
    this.persistence.save(this.map);
    this.emit();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Record the authoritative server `version` for a row after a successful
   * write, leaving every field value untouched. The store's `version` is
   * otherwise an optimistic per-mutation counter (`applyMutation` bumps it by
   * one on every local toggle), so when several local edits coalesce into a
   * single `set_item_state` write the local version outruns the server's — the
   * server row only increments once. Left unreconciled, a later cold boot whose
   * NetworkOnly hydration fails would `seedConfirmedVersions` from that inflated
   * value and base the next offline edit on a too-high `p_base_version`, which
   * the RPC rejects as a 40001 conflict and the outbox drops — losing a change
   * no other device touched. Normalizing the settled row to the confirmed server
   * version keeps the seed honest. No emit: no field changed, so nothing that
   * renders item flags needs to re-read; we only persist so the corrected
   * version survives to the next boot. */
  confirmServerVersion(id: ItemId, version: number): void {
    const cur = this.map[id];
    if (!cur || cur.version === version) return;
    this.map = { ...this.map, [id]: { ...cur, version } };
    this.persistence.save(this.map);
  }

  /** Notify subscribers without a local state change. Used by the durable outbox
   * after a write commits server-side: the local store is unchanged, but
   * subscribers that derive from *server* reads — notably the per-feed
   * unread-count query, which refetches on feed invalidation — must re-validate
   * now that the server reflects the just-synced write. Without this, that query
   * would keep the count it refetched optimistically (before the write landed)
   * cached for the stale window. */
  notifySynced(): void {
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
