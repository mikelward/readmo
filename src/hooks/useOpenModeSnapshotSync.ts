import { useEffect } from 'react';
import { useQueryClient, type QueryCacheNotifyEvent } from '@tanstack/react-query';
import {
  hasStoredOpenModeSnapshot,
  rememberOpenModes,
} from '../lib/openModeSnapshot';
import type { Subscription } from '../lib/types';
import { useAuth } from './useAuth';

type SubscriptionRows = ReadonlyArray<{ subscription: Subscription }>;

/** Whether a cache event names the shared subscriptions read (exactly
 * `['subscriptions']`, the key every owner of that read uses). */
function isSubscriptionsKey(key: readonly unknown[]): boolean {
  return key.length === 1 && key[0] === 'subscriptions';
}

/** Whether an event is a subscriptions READ that just completed — the only thing
 * that may replace what the device remembers.
 *
 * Not a cache restore: the persisted blob is written on a throttle, so it can
 * hold an older list than the device remembers, and hydration would otherwise
 * hand that back as though it were an answer. Not a manual `setQueryData`
 * either: the Feeds page patches the cached list for the UI while writing the
 * change it actually made to the snapshot itself, so taking the patched list as
 * a read would drag every other value on it along. React Query marks both — a
 * fetch result is a `success` action without `manual`. */
function isCompletedRead(event: QueryCacheNotifyEvent): boolean {
  return (
    event.type === 'updated' &&
    event.action.type === 'success' &&
    event.action.manual !== true &&
    isSubscriptionsKey(event.query.queryKey)
  );
}

/**
 * Keeps what the device remembers about its feeds' row-open settings level with
 * the server, by watching the `['subscriptions']` query for completed reads.
 *
 * Mounted ONCE, app-wide, because the read has several owners — the Feeds page,
 * the drawer, the feed pages, and the row hooks — and the one that matters most
 * is the page where a setting is *changed*: flipping a feed's open mode in
 * Settings invalidates the key under `FeedsPage`'s own query, with no article
 * list mounted. Watching only from the row hooks would leave the previous mode
 * remembered until a list was next visited.
 *
 * Subscribing to the cache rather than adding another `useQuery` observer keeps
 * this passive: it never triggers a fetch and never holds the query alive.
 *
 * Only a SIGNED-IN read is remembered, and this is the one place that knows: a
 * read taken without a session comes back empty under RLS, and a session can
 * drop on its own (an offline token refresh) without being a sign-out, so
 * remembering that empty answer would wipe what the caches are being kept for.
 * Held while auth is still initializing too — "not known yet" is not "signed
 * out". Conversely a signed-in empty list IS remembered, since unsubscribing
 * from the last feed genuinely clears every mode.
 *
 * One thing here is not a read: a device that has never stored a snapshot is
 * SEEDED from restored cache data, once. React Query treats a restored result as
 * fresh, so on the first launch after an upgrade no network read need follow it
 * for `staleTime` — and none can, offline — which would leave every row opening
 * in the reader on a feed set to open elsewhere. Seeding only fills the absence:
 * once anything is stored, restored data goes back to not counting.
 */
export function useOpenModeSnapshotSync(): void {
  const client = useQueryClient();
  const { user, initializing } = useAuth();
  const signedIn = !initializing && user !== null;
  useEffect(() => {
    if (!signedIn) return;
    // Seed once into an absence (see the note above). Attempted at mount and
    // again on cache activity, because the persisted cache restores
    // asynchronously: on the first launch after an upgrade there is usually
    // nothing to read yet at mount.
    let seeded = false;
    const seed = () => {
      if (seeded) return;
      if (hasStoredOpenModeSnapshot()) {
        seeded = true;
        return;
      }
      const data = client.getQueryData<SubscriptionRows>(['subscriptions']);
      if (data === undefined) return;
      rememberOpenModes(data);
      seeded = true;
    };
    seed();
    return client.getQueryCache().subscribe((event) => {
      if (!isSubscriptionsKey(event.query.queryKey)) return;
      if (!isCompletedRead(event)) {
        seed();
        return;
      }
      seeded = true;
      const data = client.getQueryData<SubscriptionRows>(['subscriptions']);
      if (data !== undefined) rememberOpenModes(data);
    });
  }, [client, signedIn]);
}
