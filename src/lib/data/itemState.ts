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

/** True once a TTL'd field (hidden/opened) has aged past the 7-day window. */
function expired(at: number | null, now: number): boolean {
  return at !== null && now - at > TTL_MS;
}

/** Collapse expired Hidden/Opened flags so retention is honored at read time
 * without a background sweep (SPEC.md *Retention*). Permanent states
 * (pinned/favorite/done) are never expired here. */
export function withRetention(
  state: ItemState,
  now: number = Date.now(),
): ItemState {
  let next = state;
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
  // left open past the 7-day TTL still re-includes expired rows.
  private retainedCache = new Map<
    ItemId,
    { raw: ItemState; out: ItemState; validUntil: number }
  >();
  // One level of undo, matching newshacker's "restore the last hide / swipe /
  // sweep batch" (SPEC.md *List toolbar*). Only hide-style mutations record
  // here; pin/favorite/done toggles are not toolbar-undoable.
  private lastUndo: UndoBatch | null = null;
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
    this.map = persistence.load();
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
    // Hidden/Opened flag crosses its TTL boundary; cache until the earliest
    // such boundary (else forever). This keeps repeated reads referentially
    // stable while never pinning a stale pre-expiry snapshot indefinitely.
    let validUntil = Number.POSITIVE_INFINITY;
    if (out.hidden && raw.hiddenAt !== null) {
      validUntil = Math.min(validUntil, raw.hiddenAt + TTL_MS);
    }
    if (out.opened && raw.openedAt !== null) {
      validUntil = Math.min(validUntil, raw.openedAt + TTL_MS);
    }
    this.retainedCache.set(id, { raw, out, validUntil });
    return out;
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
      next[id] = changed ? mergePending(srv, this.map[id], changed, now) : srv;
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
    const prev = this.map[id] ?? DEFAULT_ITEM_STATE;
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
   * when `ids` is empty. */
  hideMany(ids: ItemId[], now: number = Date.now()): void {
    if (ids.length === 0) return;
    const batch: UndoBatch = [];
    for (const id of ids) {
      const prev = this.map[id] ?? DEFAULT_ITEM_STATE;
      batch.push([id, this.map[id] ?? null]);
      const next = applyMutation(prev, 'done', true, now);
      this.map = { ...this.map, [id]: next };
      this.emitDiff(id, prev, next);
    }
    this.lastUndo = batch;
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
    this.persistence.save(this.map);
    this.emit();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
