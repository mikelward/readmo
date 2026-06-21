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
  // One level of undo, matching newshacker's "restore the last hide / swipe /
  // sweep batch" (SPEC.md *List toolbar*). Only hide-style mutations record
  // here; pin/favorite/done toggles are not toolbar-undoable.
  private lastUndo: UndoBatch | null = null;

  constructor(private persistence: StatePersistence) {
    this.map = persistence.load();
  }

  get(id: ItemId, now: number = Date.now()): ItemState {
    const raw = this.map[id];
    if (!raw) return DEFAULT_ITEM_STATE;
    return withRetention(raw, now);
  }

  /** All non-default, non-expired states keyed by id. */
  entries(now: number = Date.now()): Array<[ItemId, ItemState]> {
    return Object.entries(this.map).map(
      ([id, s]) => [id, withRetention(s, now)] as [ItemId, ItemState],
    );
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
      batch.push([id, this.map[id] ?? null]);
      const prev = this.map[id] ?? DEFAULT_ITEM_STATE;
      this.map = { ...this.map, [id]: applyMutation(prev, 'hidden', true, now) };
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
