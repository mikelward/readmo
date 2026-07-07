import type { QueryClient } from '@tanstack/react-query';

/**
 * How long a feed view's fetched article set stays "fresh" before an automatic
 * refresh path (remount, window-focus, or the warm-on-open prefetch) will
 * re-fetch it.
 *
 * Deliberately long: the publisher-supplied SET of articles is held stable
 * between reads so its top never re-materializes — new items sliding in, a
 * dismissed row vanishing, a server pin jumping to the pinned block — *under*
 * the reader. The top re-materializes only on an explicit pull-to-refresh, or
 * on a load/return once this much time has elapsed. (More extends the set with
 * *older* articles at the bottom — an explicit, non-jumping addition — but never
 * pulls newer top rows in.) Cross-device pin/done still reflect immediately, in
 * place, via the item-state overlay (a badge, or the row grayed/removed) — only
 * the set's membership and order are frozen. See SPEC.md *Feed views → A stable
 * set of articles*.
 */
// TODO(configurable): make this a user setting ("Auto-refresh every n hours")
// wired through configureFeedFreshness, rather than a hard-coded default. See
// TODO.md → Feed freshness.
export const FEED_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Scope the frozen-set freshness cadence to feed queries (`['feed', …]`) on the
 * given client, leaving every other query on its own (shorter) staleTime.
 * Applied to the production client (main.tsx); test clients set their own
 * staleTime and don't call this, so they stay in control of feed staleness.
 *
 * `gcTime` is raised to match: the global 60-min `gcTime` would garbage-collect
 * the frozen page while the feed route is unmounted under the reader (reading an
 * article for over an hour), so returning would cold-fetch and re-materialize
 * the set *within* its advertised freshness window. Holding the cache for the
 * whole window keeps the frozen page available right up to the re-materialize
 * boundary (Codex P2 on #411).
 */
export function configureFeedFreshness(queryClient: QueryClient): void {
  queryClient.setQueryDefaults(['feed'], {
    staleTime: FEED_STALE_MS,
    gcTime: FEED_STALE_MS,
  });
}
