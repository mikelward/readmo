// Shared core for the per-device, localStorage-backed, cross-tab-synced
// preferences read through useSyncExternalStore (home feed, reading prefs,
// collapsed feed sections, promo-dismissed flags, …). Each hook had hand-rolled
// the same external store; this collapses it into one place.
//
// The snapshot is memoized by the RAW stored string, not by a value cache: get()
// always reads localStorage and only re-parses when the string changed. That
// gives useSyncExternalStore an Object.is-stable reference between reads (so an
// object/Set value doesn't loop the store) WHILE still seeing a cross-tab write
// that landed while every consumer was unmounted (it's in localStorage, so the
// raw string differs on the next read) — the property the bespoke stores were
// careful to keep.

export interface PersistentStore<T> {
  /** getSnapshot — stable reference while the stored string is unchanged. */
  get(): T;
  set(value: T): void;
  /** Whether the last `set` was refused by storage and is being held in memory
   * (see `set`). Callers that skip a redundant write need this: comparing
   * against `get()` alone, they would find their value already "there" and
   * never retry it, so nothing would persist once storage recovered. */
  hasUnpersistedValue(): boolean;
  /** Subscribe for useSyncExternalStore: same-tab change event + cross-tab
   * `storage`. get() re-reads on notify, so the handler needn't touch state. */
  subscribe(onChange: () => void): () => void;
  /** Drop the parse memo so a test starting from `localStorage.clear()` sees a
   * clean slate (the memo is module-level and otherwise persists across cases). */
  resetForTest(): void;
}

export interface PersistentStoreConfig<T> {
  storageKey: string;
  /** Custom event dispatched on set; the store subscribes to it (+ `storage`). */
  changeEvent: string;
  /** Stable reference returned when the key is absent or unparseable. */
  defaultValue: T;
  /** Parse a stored string into T, or return undefined to fall back to default. */
  parse: (raw: string) => T | undefined;
  /** Serialize T for storage. Defaults to the value itself (string-valued prefs). */
  serialize?: (value: T) => string;
  /**
   * Whether a write storage REFUSES should be held in memory for the session.
   *
   * Off by default, because holding it splits this store from anything that
   * reads the same key directly — `lib/settingsSync` both writes localStorage
   * and reads it back (`readLocal`) for the synced prefs, so a held value would
   * show in the UI while the previous one kept syncing. Where nothing else reads
   * the key, holding is strictly better than the change vanishing unannounced.
   */
  holdRefusedWrite?: boolean;
  /**
   * Whether a write storage REFUSES should also drop what is already stored.
   *
   * Off by default, and right for a preference: the value under the refused
   * write is the user's own previous choice, so keeping it beats reverting to
   * the app default on the next launch. On for a store that is a CACHE of
   * something else (the open-mode snapshot caches the server's subscriptions),
   * where a copy known to be out of date is worse than none — an absence can be
   * refilled from the other copy on the next boot, while a stale value is
   * indistinguishable from a current one and simply wins.
   */
  discardStaleOnRefusal?: boolean;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

export function createPersistentStore<T>(
  config: PersistentStoreConfig<T>,
): PersistentStore<T> {
  const {
    storageKey,
    changeEvent,
    defaultValue,
    parse,
    serialize,
    holdRefusedWrite = false,
    discardStaleOnRefusal = false,
  } = config;

  // Parse memo keyed on the raw string. `undefined` raw = not yet read; a real
  // read records `string | null`.
  let memoRaw: string | null | undefined;
  let memoValue: T = defaultValue;

  // The last value storage REFUSED, held so the change doesn't silently revert
  // under the caller (see `set`). Boxed, so "held, and the value happens to be
  // falsy" is distinguishable from "nothing held". `over` is the raw string that
  // was in storage at the time: when it changes, somebody else wrote the key
  // (another tab, or a module that writes it directly) and storage is the
  // current answer again, so the held value is dropped.
  let unpersisted: { value: T; over: string | null } | null = null;

  function readRaw(): string | null {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }

  function get(): T {
    if (!hasWindow()) return unpersisted ? unpersisted.value : defaultValue;
    const raw = readRaw();
    if (unpersisted) {
      if (raw === unpersisted.over) return unpersisted.value;
      unpersisted = null;
    }
    if (raw === memoRaw) return memoValue;
    memoRaw = raw;
    memoValue = raw === null ? defaultValue : parse(raw) ?? defaultValue;
    return memoValue;
  }

  /**
   * Write and notify.
   *
   * A refused `setItem` — private mode, exhausted quota — used to be swallowed
   * whole: `get()` re-read storage, so the value never moved and the change
   * vanished with no sign. That is fine for a preference the user can set again
   * and wrong for anything the UI *reads back*, which is most of what lives
   * here. So a refused write is held in memory instead, which is exactly as
   * durable as that device can be, and dropped the moment storage takes one.
   *
   * Installed BEFORE the notification, because the subscriber re-reads
   * synchronously from inside it: assign afterwards and it sees the old value,
   * schedules no render, and the change only surfaces on some unrelated one.
   */
  function set(value: T): void {
    if (!hasWindow()) return;
    let refused = false;
    try {
      window.localStorage.setItem(
        storageKey,
        serialize ? serialize(value) : String(value),
      );
    } catch {
      refused = true;
      if (holdRefusedWrite && discardStaleOnRefusal) {
        try {
          // What is stored is now known to be out of date, and it outlives the
          // in-memory copy: after a reload it would read as current and win.
          window.localStorage.removeItem(storageKey);
        } catch {
          // Storage refusing removal too (fully blocked) leaves nothing stored
          // to go stale in the first place.
        }
      }
    }
    unpersisted =
      refused && holdRefusedWrite ? { value, over: readRaw() } : null;
    // get() re-reads the now-updated string (or the held value) and yields a
    // fresh snapshot.
    window.dispatchEvent(new Event(changeEvent));
  }

  function hasUnpersistedValue(): boolean {
    return unpersisted !== null;
  }

  function subscribe(onChange: () => void): () => void {
    if (!hasWindow()) return () => {};
    window.addEventListener(changeEvent, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(changeEvent, onChange);
      window.removeEventListener('storage', onChange);
    };
  }

  function resetForTest(): void {
    memoRaw = undefined;
    memoValue = defaultValue;
    unpersisted = null;
  }

  return { get, set, subscribe, hasUnpersistedValue, resetForTest };
}
