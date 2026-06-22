import {
  DEFAULT_ITEM_STATE,
  TTL_MS,
  type ItemId,
  type ItemState,
  type ItemStateField,
} from '../types';

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

  /** Overlay authoritative server state onto the local store, keeping the
   * higher `version` per item so an in-flight optimistic bump isn't clobbered by
   * a stale server row (and vice-versa). Used by SupabaseDataSource after
   * fetching the caller's item_state rows. Persists + notifies once. */
  hydrate(rows: Array<[ItemId, ItemState]>): void {
    if (rows.length === 0) return;
    let changed = false;
    const next = { ...this.map };
    for (const [id, incoming] of rows) {
      const cur = next[id];
      if (!cur || incoming.version >= cur.version) {
        next[id] = incoming;
        changed = true;
      }
    }
    if (!changed) return;
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

  /** Hide one item, recording an undo point so the toolbar Undo can restore
   * it. Distinct from `set(id, 'hidden', true)` which is not undoable. */
  hide(id: ItemId, now: number = Date.now()): void {
    this.hideMany([id], now);
  }

  /** Sweep: hide many items as a single undoable batch (oldest snapshot
   * wins on restore). No-op when `ids` is empty. */
  hideMany(ids: ItemId[], now: number = Date.now()): void {
    if (ids.length === 0) return;
    const batch: UndoBatch = [];
    for (const id of ids) {
      const prev = this.map[id] ?? DEFAULT_ITEM_STATE;
      batch.push([id, this.map[id] ?? null]);
      const next = applyMutation(prev, 'hidden', true, now);
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
