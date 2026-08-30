import { useCallback, useSyncExternalStore } from 'react';
import type { Item } from '../lib/types';
import { REVEALED_SPOILERS_KEY } from '../lib/userCache';
import { createPersistentStore } from '../lib/persistentStore';

// Which spoiler-free headlines the reader has tapped open (SPEC.md *Spoiler-free
// sports headlines*), persisted in localStorage as a JSON array and shared
// across tabs and every mounted row via createPersistentStore — the same shape
// useCollapsedFeeds uses.
//
// Persisted rather than held in the row because re-hiding a headline the reader
// has already read is pointless friction: a refresh, a pull-to-refresh, a re-key
// from flipping sort or grouping, and a PWA relaunch all remount the row, and
// each one used to take the reveal back. The knowledge doesn't come back with it.
//
// PER-DEVICE. Syncing "I peeked at this one" is a bigger claim than it looks: it
// would need a column on `item_state` (a migration and a manual deploy), and it
// would write a server row for a headline the reader merely glanced at, on a
// table whose rows otherwise mean something durable. Deferred as a decision, not
// ruled out (TODO.md) — the client keeps a set of keys, so syncing later is
// additive. The storage key is purged on account change (guardrail #8,
// userCache.ts): the set names items one account chose to look at.

export { REVEALED_SPOILERS_KEY };
const CHANGE_EVENT = 'readmo:revealed-spoilers-changed';

// Unlike the collapsed-feeds set — bounded by how many feeds you subscribe to —
// this one grows with every headline ever tapped, so it needs a ceiling or it
// grows for the life of the install. A revealed row is only worth remembering
// while it's still in a feed you're reading, and 500 entries (~25 KB) covers far
// more than any list holds; older reveals fall off the front, oldest first.
// Overshooting the localStorage budget would be the worse failure: a quota error
// on write is silent and would strand the whole set.
export const MAX_REVEALED = 500;

const EMPTY: ReadonlySet<string> = new Set();

const revealedStore = createPersistentStore<ReadonlySet<string>>({
  storageKey: REVEALED_SPOILERS_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: EMPTY,
  parse: (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((x): x is string => typeof x === 'string')
          : [],
      );
    } catch {
      return undefined;
    }
  },
  serialize: (set) => JSON.stringify([...set]),
});

// FNV-1a, 32 bits, hex. Not a security hash — just enough that two different
// headlines on the same row don't collide in practice, in a few bytes rather
// than the whole title.
function fingerprint(title: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < title.length; i += 1) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** What a reveal is remembered under: the item AND a fingerprint of the headline
 * it was revealed for.
 *
 * The id alone would be a spoiler leak. A publisher can update an article in
 * place, and the poller's upsert keeps the row's id while replacing the title
 * and nulling the cached rewrite for re-classification (migration 0045) — so a
 * live-blog row you opened up at "MNU v ARS spoiler" can come back carrying a
 * different result, and an id-keyed reveal would show it to you unasked. Keying
 * on the headline too means a changed one simply isn't the thing you revealed. */
export function revealKey(item: Pick<Item, 'id' | 'title'>): string {
  return `${item.id}:${fingerprint(item.title)}`;
}

// Reveals that could not be written to localStorage (quota exhausted, storage
// denied) still have to hold for this session. `createPersistentStore.set()`
// swallows a failed write and `get()` then keeps returning the old set, which
// for a preference just means it doesn't stick — but here it would leave the row
// concealed with the tap guard still armed, so the body's first tap would keep
// revealing and never open the article. This set is the guarantee that a reveal
// always takes effect; localStorage is what carries it across reloads.
//
// ONLY refused writes belong here. Mirroring every reveal would union the
// entries `capped()` just evicted straight back into the snapshot, so the cap
// would hold in storage and do nothing in the running app — and this set would
// grow for the life of the session. It carries the same ceiling for the case
// where storage is refusing every write (a private window), where it is the only
// copy there is.
//
// REPLACED on every change, never mutated in place, so its identity is the whole
// answer to "has this moved?". Mutating it and tracking size instead left a hole
// at the ceiling — adding one key and evicting the oldest leaves the size alone,
// so the memo below would hand back a snapshot without the key just added, and
// the row could never be revealed OR opened again (`reveal` early-returns on a
// key it can see in here). Identity has no such blind spot.
let sessionRevealed: ReadonlySet<string> = EMPTY;

// Union of the two, memoized so useSyncExternalStore gets an Object.is-stable
// snapshot between reads. Keyed on both inputs BY REFERENCE: the persisted one
// changes on a successful write, the session one on a refused write — which is
// what re-renders the row in that case, since the persisted snapshot alone comes
// back identical.
let unionMemo: ReadonlySet<string> = EMPTY;
let unionPersisted: ReadonlySet<string> | undefined;
let unionSession: ReadonlySet<string> | undefined;

function effectiveRevealed(): ReadonlySet<string> {
  const persisted = revealedStore.get();
  if (persisted === unionPersisted && sessionRevealed === unionSession) {
    return unionMemo;
  }
  unionPersisted = persisted;
  unionSession = sessionRevealed;
  unionMemo =
    sessionRevealed.size === 0
      ? persisted
      : new Set([...persisted, ...sessionRevealed]);
  return unionMemo;
}

/** Drop the oldest entries once the set is over the cap. Sets iterate in
 * insertion order, so the front is the least recently revealed. */
function capped(next: Set<string>): Set<string> {
  if (next.size <= MAX_REVEALED) return next;
  return new Set([...next].slice(next.size - MAX_REVEALED));
}

/** Clear every remembered reveal. The list toolbar's eye calls this as it
 * re-hides: "re-hide all" that left yesterday's tapped rows showing their
 * scorelines wouldn't be all. A plain function, not a hook, so the toggle can
 * call it without every row subscribing to the store. */
export function clearRevealedSpoilers(): void {
  const hadSession = sessionRevealed.size > 0;
  sessionRevealed = EMPTY;
  if (!hadSession && revealedStore.get().size === 0) return;
  // Always through the store, even when only the session set had entries: its
  // set() is what notifies subscribers.
  revealedStore.set(EMPTY);
}

/** Test seam: drop the parse memo and the session fallback so a case starting
 * from `localStorage.clear()` sees a clean slate. */
export function resetRevealedSpoilersCacheForTest(): void {
  sessionRevealed = EMPTY;
  unionPersisted = undefined;
  unionSession = undefined;
  unionMemo = EMPTY;
  revealedStore.resetForTest();
}

export interface RevealedSpoilers {
  /** Whether this item's headline — this exact headline — has been revealed. */
  isRevealed: (item: Pick<Item, 'id' | 'title'>) => boolean;
  /** Remember a reveal. Idempotent: re-revealing doesn't reorder the set, so a
   * row already remembered isn't refreshed to the back of the eviction queue by
   * a second render. */
  reveal: (item: Pick<Item, 'id' | 'title'>) => void;
}

/** Per-device memory of which spoiler headlines have been tapped open. */
export function useRevealedSpoilers(): RevealedSpoilers {
  const revealed = useSyncExternalStore(
    revealedStore.subscribe,
    effectiveRevealed,
    effectiveRevealed,
  );

  const isRevealed = useCallback(
    (item: Pick<Item, 'id' | 'title'>) => revealed.has(revealKey(item)),
    [revealed],
  );

  const reveal = useCallback((item: Pick<Item, 'id' | 'title'>) => {
    const key = revealKey(item);
    const current = revealedStore.get();
    if (current.has(key) || sessionRevealed.has(key)) return;
    revealedStore.set(capped(new Set(current).add(key)));
    // `set()` swallows a refused write, so ask the store whether it actually
    // landed rather than assuming either way.
    if (revealedStore.get().has(key)) return;
    const nextSession = new Set(sessionRevealed).add(key);
    if (nextSession.size > MAX_REVEALED) {
      // Sets iterate in insertion order, so this is the least recent.
      const oldest = nextSession.values().next().value;
      if (oldest !== undefined) nextSession.delete(oldest);
    }
    sessionRevealed = nextSession;
    // The persisted snapshot came back unchanged, so the store's own dispatch
    // inside set() told subscribers nothing. Fire the same event again now that
    // the fallback holds the reveal — CHANGE_EVENT is this module's, and the
    // store subscribes to it.
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { isRevealed, reveal };
}
