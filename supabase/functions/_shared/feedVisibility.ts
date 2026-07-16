// Shared "is this feed public?" check for the reading-mode / summary Edge
// Functions, and the service-role read that lets a shared /item/<id> link resolve
// full text for a caller who doesn't subscribe to the feed.
//
// A shared link is a CAPABILITY: the item's uuid is unguessable, so possession of
// the link is the authorization. The user-JWT item lookup in fulltext/summary is
// RLS-scoped and 404s for a non-subscriber, so — after the allowlist gate has
// already passed — we re-read the item via the service role and accept it ONLY
// when its parent feed is PUBLIC. "Public" mirrors the SQL get_shared_item gate
// (0068): no secret_url AND the fetch url doesn't look tokenized. This is the
// same soft paywall gate, sharing the TS looksTokenized heuristic so the DB and
// Edge sides agree.

import { looksTokenized } from './urlSafety.ts';

export interface FeedPrivacyRow {
  url: string | null;
  secret_url: string | null;
}

/** True when a feed is public (shareable to non-subscribers): no secret_url and
 * a fetch url that doesn't look like it embeds a token. Conservative — an absent
 * or tokenized url is treated as private. This is the soft paywall gate (the
 * item uuid is the real boundary), sharing the TS `looksTokenized` heuristic with
 * the SQL `get_shared_item` gate (0068). */
export function feedIsPublic(feed: FeedPrivacyRow | null | undefined): boolean {
  if (!feed || !feed.url) return false;
  if (feed.secret_url) return false;
  // Only http(s), mirroring the SQL `looks_tokenized` scheme gate (0068:
  // `p_url !~* '^https?://'`). `looksTokenized` alone doesn't validate the
  // scheme, so a legacy/malformed `ftp://` or `javascript:` row would otherwise
  // pass here while `get_shared_item` withholds it — keep the DB/Edge parity
  // fail-closed.
  // TODO(follow-up): reject non-http(s) feed URLs EARLY at ingestion
  // (subscribe/discover/poll) so such rows never reach `feeds` at all, making
  // this per-read scheme guard belt-and-braces rather than the only line.
  if (!/^https?:\/\//i.test(feed.url)) return false;
  return !looksTokenized(feed.url);
}

/** Service-role read of an item ONLY when its parent feed is public — the shared
 * fallback for a caller who can't see the item under items_select RLS but is
 * opening a shared PUBLIC-feed link (0068). Returns the item row (with the
 * requested `columns`, which MUST include `feed_id`) or null when the item is
 * missing or its feed is private. The caller must have already passed the
 * allowlist gate. */
export async function readItemIfPublicFeed(
  service: {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          k: string,
          v: string,
        ) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> };
      };
    };
  },
  itemId: string,
  columns: string,
): Promise<Record<string, unknown> | null> {
  const { data: item, error } = await service
    .from('items')
    .select(columns)
    .eq('id', itemId)
    .maybeSingle();
  // A lookup ERROR is a transient PostgREST/DB blip, NOT a miss — throw so the
  // caller reports a RETRYABLE failure (`unreachable`) instead of a terminal 404
  // the client caches as `empty` (which would strand an allowlisted recipient on
  // the feed body until cache eviction). `null` is reserved for a genuine miss or
  // a private feed.
  if (error) throw asError(error);
  if (!item) return null;
  const feedId = (item as { feed_id?: string }).feed_id;
  if (!feedId) return null;
  const { data: feed, error: feedError } = await service
    .from('feeds')
    .select('url, secret_url')
    .eq('id', feedId)
    .maybeSingle();
  if (feedError) throw asError(feedError);
  return feedIsPublic(feed as FeedPrivacyRow | null) ? (item as Record<string, unknown>) : null;
}

/** Normalize a PostgREST error object to an Error to throw. */
function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  const msg = (e as { message?: unknown } | null)?.message;
  return new Error(typeof msg === 'string' ? msg : String(e));
}
