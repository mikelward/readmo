import { errorMessage } from './loadErrorCopy';
import { formatTimeAgoLong } from './format';

// The most recent feed-list fetch outcome, for `/debug`'s "Last fetch" row.
// The reader is usually on a phone with no console, so when a refresh
// silently fails (rate limited, backend erroring, offline) this is the
// reachable evidence of whether the fetch ran at all, when, and what the
// server actually said. Session-local by design: it describes THIS session's
// behavior, not history.

export interface LastFeedFetch {
  /** Epoch ms the fetch settled. */
  at: number;
  ok: boolean;
  /** The failure's human-readable message (same text the failure strip's
   * Details disclosure shows); null on success. */
  error: string | null;
}

let last: LastFeedFetch | null = null;

/** Record a settled feed-list fetch. Canceled fetches (superseded by
 * navigation/pagination) are not outcomes and must not be recorded. */
export function recordFeedFetch(ok: boolean, error?: unknown): void {
  last = { at: Date.now(), ok, error: ok ? null : errorMessage(error) };
}

export function getLastFeedFetch(): LastFeedFetch | null {
  return last;
}

/** The `/debug` "Last fetch" row value: relative time + outcome, with the
 * failure message inline so it's readable without a desktop. */
export function formatLastFeedFetch(
  fetch: LastFeedFetch | null,
  now: number = Date.now(),
): string {
  if (fetch === null) return 'not yet';
  const ago = formatTimeAgoLong(Math.floor(fetch.at / 1000), new Date(now));
  if (fetch.ok) return `${ago} · ok`;
  return `${ago} · failed${fetch.error ? `: ${fetch.error}` : ''}`;
}

export function _resetLastFeedFetchForTests(): void {
  last = null;
}
