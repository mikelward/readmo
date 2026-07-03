// Which feeds an on-demand `/refresh` call is allowed to poll.
//
// Normal callers are scoped to their own subscriptions — a user must not be able
// to force-poll a feed they don't subscribe to (the refresh endpoint resolves
// the target via the caller's RLS-bound `subscriptions` read). The `/admin/feeds`
// operator console, however, lists EVERY system feed, so an admin may also
// refresh a specifically-named feed they don't personally subscribe to — but
// only that one named feed, never a blanket all-feeds poll.

export interface RefreshScopeInput {
  /** feed_ids from the caller's subscription read (already filtered to the
   * requested feed when a `feedId` was given, so this is `[feedId]` when the
   * caller subscribes to it, else `[]`). */
  subscribedFeedIds: string[];
  /** The specific feed requested, if any. */
  feedId?: string | null;
  /** Whether the caller is an operator (`admin_users`). */
  isAdmin: boolean;
}

/**
 * Resolve the feed ids to refresh. A subscribed caller refreshes their matching
 * subscription(s); an admin additionally may refresh one named, unsubscribed
 * system feed (the admin console case). Everyone else gets nothing.
 */
export function feedsToRefresh({
  subscribedFeedIds,
  feedId,
  isAdmin,
}: RefreshScopeInput): string[] {
  if (subscribedFeedIds.length > 0) return subscribedFeedIds;
  // No matching subscription. Allow an admin to refresh one specifically-named
  // system feed; never widen a no-feedId "refresh all" into an all-system poll.
  if (feedId && isAdmin) return [feedId];
  return [];
}
