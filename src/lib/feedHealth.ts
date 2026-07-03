import type { AdminFeedStatus } from './data/DataSource';

/** The single at-a-glance status shown per feed on `/admin/feeds`, derived in
 * priority order (first match wins):
 *   0. `paused`       — the operator paused the feed (no polling/downloads);
 *                       overrides everything else, since nothing else runs;
 *   1. `poll-failed`  — the feed's most recent poll errored (nothing downstream
 *                       matters until the feed itself refreshes);
 *   2. `not-tried`    — no reading-mode download has been attempted for any of
 *                       the feed's articles, so there's nothing to report;
 * then, for the feed's most recent reading-mode download attempt:
 *   3. `downloaded`   — full article body is cached (a success);
 *   4. `blocked`      — the publisher gated it (401/403) and Jina couldn't help;
 *   5. `unreachable`  — the fetch failed (network / SSRF-blocked / non-2xx);
 *   6. `empty`        — fetched but nothing extractable (paywall / robots / teaser). */
export type FeedHealth =
  | 'paused'
  | 'poll-failed'
  | 'not-tried'
  | 'downloaded'
  | 'blocked'
  | 'unreachable'
  | 'empty';

/** Derive the one-line {@link FeedHealth} for a feed. A cached body (or a
 * recorded `ok`) is treated as `downloaded`, so an article fetched before
 * attempts were recorded still reads as a success. */
export function feedHealth(feed: AdminFeedStatus): FeedHealth {
  if (feed.paused) return 'paused';
  if (feed.fetchFailed) return 'poll-failed';
  const sample = feed.sample;
  if (!sample) return 'not-tried';
  if (sample.hasFullContent || sample.downloadStatus === 'ok') return 'downloaded';
  switch (sample.downloadStatus) {
    case 'auth':
      return 'blocked';
    case 'unreachable':
      return 'unreachable';
    case 'empty':
      return 'empty';
    default:
      return 'not-tried';
  }
}

/** Human-readable label for each status (US English). */
export const FEED_HEALTH_LABEL: Record<FeedHealth, string> = {
  paused: 'Paused',
  'poll-failed': 'Poll failed',
  'not-tried': 'Not tried',
  downloaded: 'Downloaded',
  blocked: 'Blocked',
  unreachable: 'Unreachable',
  empty: 'Empty',
};

/** The failures the "Unhealthy" filter keeps: a broken poll, or a download that
 * actively failed (blocked / unreachable). `empty` and `not-tried` are
 * informational, not failures, so they don't count. */
export function isUnhealthy(health: FeedHealth): boolean {
  return health === 'poll-failed' || health === 'blocked' || health === 'unreachable';
}
