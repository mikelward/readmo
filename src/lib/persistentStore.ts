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
   * clean slate (the memo is module-level and otherwise persists across cases).
   * Also clears the shared storage-health flag below. */
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

// ---------------------------------------------------------------------------
// Storage health, shared by every store on this origin.
//
// Quota and availability are properties of the ORIGIN, not of a key: once one
// write is refused, the next one is refused too, and a device that is out of
// space stays out of space until something frees some. Every store attempting
// (and catching) its own write means one exception per store per pass — a sync
// or a boot touches several — for an answer the first one already gave.
//
// So a refusal is recorded here, and for a cooldown it suppresses the attempts
// that would only ask the same question again: a store re-writing a value it is
// already holding. That is the repetitive one — a held value is retried by
// whatever writes next, and what writes next is usually a poll re-recording
// flags that have not changed. A write carrying something NEW always tries, even
// mid-cooldown: it is the user having just done something, and a value dropped
// for ten seconds to save an exception is a bad trade. Success clears the flag
// for everyone; expiry lets the next retry probe.
//
// (What this does NOT yet do is flush every OTHER store's held value when a
// probe succeeds — see TODO.md.)
const WRITE_RETRY_COOLDOWN_MS = 10_000;
// `performance.now()`, not `Date.now()`: the wall clock can move BACKWARD (a
// manual correction, an NTP step), and an elapsed time computed from it goes
// negative — which reads as "still inside the cooldown" and suppresses the
// retries indefinitely, exactly when the value is sitting in memory waiting for
// one. `undefined` = no refusal recorded.
let writesRefusedAt: number | undefined;

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function storageRefusingWrites(): boolean {
  return (
    writesRefusedAt !== undefined &&
    monotonicNow() - writesRefusedAt < WRITE_RETRY_COOLDOWN_MS
  );
}

/** Test seam: forget that storage was refusing writes. */
export function resetStorageHealthForTest(): void {
  writesRefusedAt = undefined;
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
  // falsy" is distinguishable from "nothing held".
  //
  // `over` is the raw string that was stored at the time: when it changes,
  // somebody else wrote the key (another tab, or a module that writes it
  // directly) and storage is the current answer again, so the held value stands
  // down. `undefined` means the read that went with the refusal ALSO threw, so
  // no baseline was seen — kept distinct from a known-absent `null`, because
  // collapsing the two makes a later recovery look exactly like a cross-tab
  // write and reverts the user's change on the next read. Whatever is there at
  // the first readable moment becomes the baseline, and the held value goes on
  // masking it until somebody writes over THAT.
  let unpersisted: { value: T; raw: string; over: string | null | undefined } | null =
    null;

  /** A read that reports whether storage answered at all, separately from what
   * it held. */
  function storedRead(): { ok: true; raw: string | null } | { ok: false } {
    try {
      return { ok: true, raw: window.localStorage.getItem(storageKey) };
    } catch {
      return { ok: false };
    }
  }

  /** The raw string this store currently speaks for: what is stored, or the
   * held value while it is still masking the baseline it was written over. */
  function resolveRaw(): string | null {
    const read = storedRead();
    if (!unpersisted) return read.ok ? read.raw : null;
    // A read that threw says nothing about the key, so keep holding.
    if (!read.ok) return unpersisted.raw;
    if (unpersisted.over === undefined) {
      // First readable moment since the refusal: adopt what is there as the
      // baseline (see `unpersisted`).
      unpersisted.over = read.raw;
      return unpersisted.raw;
    }
    if (read.raw === unpersisted.over) return unpersisted.raw;
    unpersisted = null;
    return read.raw;
  }

  function get(): T {
    if (!hasWindow()) return unpersisted ? unpersisted.value : defaultValue;
    const raw = resolveRaw();
    if (unpersisted && raw === unpersisted.raw) return unpersisted.value;
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
   *
   * The notification itself is skipped when nothing this store speaks for
   * actually moved. A routine rewrite of the same value is common (a completed
   * read re-remembering what it already knew), and every subscriber re-rendering
   * for it is work nobody asked for.
   */
  function set(value: T): void {
    if (!hasWindow()) return;
    const previousRaw = resolveRaw();
    const raw = serialize ? serialize(value) : String(value);

    // A pure retry: this store is already holding exactly this value, so the
    // write carries no new intent and can wait out the cooldown (see above).
    const isRetry = unpersisted !== null && unpersisted.raw === raw;

    let refused = false;
    if (holdRefusedWrite && isRetry && storageRefusingWrites()) {
      refused = true;
    } else {
      try {
        window.localStorage.setItem(storageKey, raw);
        writesRefusedAt = undefined;
      } catch {
        refused = true;
        writesRefusedAt = monotonicNow();
      }
    }

    if (refused && holdRefusedWrite && discardStaleOnRefusal) {
      try {
        // What is stored is now known to be out of date, and it outlives the
        // in-memory copy: after a reload it would read as current and win.
        window.localStorage.removeItem(storageKey);
      } catch {
        // Storage refusing removal too (fully blocked) leaves nothing stored
        // to go stale in the first place.
      }
    }

    if (refused && holdRefusedWrite) {
      const read = storedRead();
      unpersisted = { value, raw, over: read.ok ? read.raw : undefined };
    } else {
      unpersisted = null;
    }

    // resolveRaw() now reports the stored string, or the held value.
    if (resolveRaw() === previousRaw) return;
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
    resetStorageHealthForTest();
  }

  return { get, set, subscribe, hasUnpersistedValue, resetForTest };
}
