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
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

export function createPersistentStore<T>(
  config: PersistentStoreConfig<T>,
): PersistentStore<T> {
  const { storageKey, changeEvent, defaultValue, parse, serialize } = config;

  // Parse memo keyed on the raw string. `undefined` raw = not yet read; a real
  // read records `string | null`.
  let memoRaw: string | null | undefined;
  let memoValue: T = defaultValue;

  function get(): T {
    if (!hasWindow()) return defaultValue;
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(storageKey);
    } catch {
      raw = null;
    }
    if (raw === memoRaw) return memoValue;
    memoRaw = raw;
    memoValue = raw === null ? defaultValue : parse(raw) ?? defaultValue;
    return memoValue;
  }

  function set(value: T): void {
    if (!hasWindow()) return;
    try {
      window.localStorage.setItem(
        storageKey,
        serialize ? serialize(value) : String(value),
      );
    } catch {
      // quota / privacy-mode failures are non-fatal; the change just reverts on
      // the next load.
    }
    // get() re-reads the now-updated string and yields a fresh snapshot.
    window.dispatchEvent(new Event(changeEvent));
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
  }

  return { get, set, subscribe, resetForTest };
}
