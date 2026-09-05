// What this device knows about its feeds' row-open settings — the open mode
// (`open_original` / `open_newshacker`) and `mark_done_on_open`.
//
// A row's first frame is tappable, so it has to know where it opens before it
// can be tapped. Those settings live on the subscription and arrive through the
// `['subscriptions']` query, which is asynchronous: until it answers there is
// nothing to derive them from, and treating that as "no feed opens externally"
// is a claim rather than an absence — the row renders as a reader row, and a tap
// in that window opens the in-app reader on a feed set to open elsewhere.
//
// So the device remembers. This store is written synchronously and read
// synchronously, and it is the ONE copy the rows read: the query is where the
// answer comes FROM, not a second opinion to weigh against this. Two
// authoritative copies is what the earlier version of this file had, and
// reconciling them cost an ordering predicate, a clock-correction exception, a
// stamp floor and a tie-break, each exposing the next (#700). None of that
// exists now, and neither do the failures it was handling.
//
// Two things write here, and nothing else:
//   - a COMPLETED subscriptions read (useOpenModeSnapshotSync), which replaces
//     the lot: it is the server's answer for this account. Restored cache data
//     is not a read and does not qualify.
//   - a SETTLED mutation (FeedsPage), which updates the one feed it changed.
//
// One exception, and only into an absence: a device that has never stored a
// snapshot is seeded once from restored cache data (useOpenModeSnapshotSync
// again), so an upgrade doesn't start every row in reader mode until a network
// read happens to follow. Seeding what is missing is not a second opinion —
// there is nothing here for it to disagree with.
//
// The same shape the account's reading-behavior prefs already use — localStorage
// is what the UI reads on the first frame, with an async reconcile layered on
// top (lib/settingsSync). The server stays the source of truth: this is a cache
// of the last read, and a change made on another device arrives here with that
// device's next completed read.
//
// Deliberately NOT a full mirror of the subscription list: only the flags a row
// acts on when tapped. `listLayout` (appearance) stays query-only — a stale
// layout would flip visibly on first paint, and getting it wrong costs nothing.
//
// PER-DEVICE, and purged on account change (guardrail #8, lib/userCache.ts): the
// feed ids in here name one account's subscriptions.

import { createPersistentStore } from './persistentStore';
import type { FeedId, Subscription } from './types';
import { OPEN_MODE_SNAPSHOT_KEY } from './userCache';

/** The subscription flags a row's tap acts on. */
export type RowOpenFlag = 'openOriginal' | 'openNewshacker' | 'markDoneOnOpen';

const FLAGS: readonly RowOpenFlag[] = [
  'openOriginal',
  'openNewshacker',
  'markDoneOnOpen',
];

/** Which feeds carry each flag, as of the last thing that wrote here. */
export type OpenModeSnapshot = Readonly<Record<RowOpenFlag, ReadonlySet<FeedId>>>;

/** Stable reference for "nothing remembered", so a hook memo keyed on the
 * snapshot doesn't churn on every read. */
export const EMPTY_OPEN_MODE_SNAPSHOT: OpenModeSnapshot = {
  openOriginal: new Set<FeedId>(),
  openNewshacker: new Set<FeedId>(),
  markDoneOnOpen: new Set<FeedId>(),
};

function idsFrom(value: unknown): ReadonlySet<FeedId> {
  return new Set(
    Array.isArray(value) ? value.filter((id): id is FeedId => typeof id === 'string') : [],
  );
}

const store = createPersistentStore<OpenModeSnapshot>({
  storageKey: OPEN_MODE_SNAPSHOT_KEY,
  changeEvent: 'readmo:open-modes-changed',
  // Nothing else reads this key, so a refused write is held for the session
  // rather than vanishing — the rows read only this store.
  holdRefusedWrite: true,
  // And this is a cache of the server's subscriptions, so a copy known to be out
  // of date is worse than none: the seed in useOpenModeSnapshotSync can refill an
  // absence from the restored query cache on the next boot, while a stale value
  // reads as current and beats it.
  discardStaleOnRefusal: true,
  defaultValue: EMPTY_OPEN_MODE_SNAPSHOT,
  parse: (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return undefined;
      const record = parsed as Record<string, unknown>;
      return {
        openOriginal: idsFrom(record.openOriginal),
        openNewshacker: idsFrom(record.openNewshacker),
        markDoneOnOpen: idsFrom(record.markDoneOnOpen),
      };
    } catch {
      return undefined;
    }
  },
  serialize: (snapshot) =>
    JSON.stringify({
      openOriginal: [...snapshot.openOriginal],
      openNewshacker: [...snapshot.openNewshacker],
      markDoneOnOpen: [...snapshot.markDoneOnOpen],
    }),
});

/** What this device knows. Reference-stable while the stored string is unchanged
 * (see createPersistentStore), so a hook memo can key on it. A write storage
 * refused — private mode, exhausted quota — is held in memory by the store and
 * comes back from here too: the rows read only this, so a swallowed write would
 * otherwise leave every feed in reader mode for the whole session. */
export function readOpenModeSnapshot(): OpenModeSnapshot {
  return store.get();
}

/** Subscribe for `useSyncExternalStore` (same-tab writes + cross-tab
 * `storage`). */
export const subscribeOpenModeSnapshot = store.subscribe;

/** Whether this device has ever stored a snapshot — "nothing remembered yet"
 * told apart from "remembered, and no feed carries a flag", which read the same
 * through {@link readOpenModeSnapshot}.
 *
 * The one caller is the seed in useOpenModeSnapshotSync: a device upgrading to
 * this version has a restored `['subscriptions']` cache and no snapshot, and a
 * restored result is fresh enough that no network read need follow it for
 * minutes (forever, offline). Seeding fills that gap ONCE, and only into the
 * absence — it is not a second authority, since there is nothing here for it to
 * outrank. */
export function hasStoredOpenModeSnapshot(): boolean {
  try {
    return window.localStorage.getItem(OPEN_MODE_SNAPSHOT_KEY) !== null;
  } catch {
    // Storage disabled (private mode, blocked cookies): nothing is remembered
    // and nothing can be, so report the absence rather than throwing on a path
    // that runs while the app boots.
    return false;
  }
}

function sameIds(a: ReadonlySet<FeedId>, b: ReadonlySet<FeedId>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function sameSnapshot(a: OpenModeSnapshot, b: OpenModeSnapshot): boolean {
  return FLAGS.every((flag) => sameIds(a[flag], b[flag]));
}

function write(next: Record<RowOpenFlag, Set<FeedId>>): void {
  // A no-op when nothing moved, so a routine refetch neither writes storage nor
  // notifies a single subscriber. While a refused write is held in memory the
  // write is retried instead — the reads that follow carry the same flags, so
  // comparing against the held value alone would skip every one of them and
  // nothing would persist even after storage recovered.
  if (!store.hasUnpersistedValue() && sameSnapshot(next, store.get())) return;
  store.set(next);
}

/**
 * Replace what is remembered with the flags a COMPLETED subscriptions read
 * carried. The caller decides what counts as one (useOpenModeSnapshotSync):
 * a read taken without a session comes back empty under RLS, and a session can
 * drop on its own — an offline token refresh, which `useUserCacheScope`
 * deliberately does not treat as a sign-out — so remembering that empty answer
 * would wipe what the caches are being kept for.
 *
 * A signed-in EMPTY list is honored, not ignored: unsubscribing from the last
 * feed really does mean no feed opens anywhere, and a stale entry is not inert —
 * a pinned, favorited or done article stays readable through its permanent
 * `item_state` after its feed is gone, so its row in a library view would still
 * find the flag.
 */
export function rememberOpenModes(
  subscriptions: ReadonlyArray<{ subscription: Subscription }>,
): void {
  const next: Record<RowOpenFlag, Set<FeedId>> = {
    openOriginal: new Set(),
    openNewshacker: new Set(),
    markDoneOnOpen: new Set(),
  };
  for (const { subscription } of subscriptions) {
    for (const flag of FLAGS) {
      if (subscription[flag]) next[flag].add(subscription.feedId);
    }
  }
  write(next);
}

/** Record ONE feed's flags from a settled mutation — the reader just changed
 * this setting, and the write has already succeeded on the server.
 *
 * Separate from the read path because the refetch a change kicks off is not
 * awaited and may never land (offline, or the app closed with the menu). Waiting
 * for it would leave the change on the server, absent here, and the next launch
 * would open the first tap on the old setting. Only the changed feed is touched,
 * so nothing else in the list has to be current for this to be safe. */
export function rememberFeedOpenModes(
  feedId: FeedId,
  flags: Partial<Record<RowOpenFlag, boolean>>,
): void {
  const current = readOpenModeSnapshot();
  const next: Record<RowOpenFlag, Set<FeedId>> = {
    openOriginal: new Set(current.openOriginal),
    openNewshacker: new Set(current.openNewshacker),
    markDoneOnOpen: new Set(current.markDoneOnOpen),
  };
  for (const flag of FLAGS) {
    const value = flags[flag];
    if (value === undefined) continue;
    if (value) next[flag].add(feedId);
    else next[flag].delete(feedId);
  }
  write(next);
}

/** Drop one feed, for a settled unsubscribe. Same reasoning as
 * {@link rememberFeedOpenModes}: only this feed is touched. */
export function forgetFeedOpenModes(feedId: FeedId): void {
  const current = readOpenModeSnapshot();
  const next: Record<RowOpenFlag, Set<FeedId>> = {
    openOriginal: new Set(current.openOriginal),
    openNewshacker: new Set(current.openNewshacker),
    markDoneOnOpen: new Set(current.markDoneOnOpen),
  };
  for (const flag of FLAGS) next[flag].delete(feedId);
  write(next);
}

/** Test seam: drop the parse memo so a case starting from `localStorage.clear()`
 * sees a clean slate (the memo is module-level). */
export function resetOpenModeSnapshotForTest(): void {
  store.resetForTest();
}
