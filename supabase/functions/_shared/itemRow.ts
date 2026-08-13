// The one place a parsed feed item becomes an `upsert_feed_items` row.
//
// Both writers — the cron poller (_shared/poller.ts) and the manual refresh
// handler (refresh/index.ts) — build this payload, and until now each built it
// independently from near-identical code. That was survivable while every field
// came straight off the parsed item, and stopped being survivable once one of
// them is DERIVED: `title_normalized` has to agree with `title` or the feed
// RPCs filter an article on text it no longer has, hiding a row the client
// shows. A second call site that forgets to recompute it is the whole failure,
// and "remember to update the other one" is exactly the invariant that decays.
//
// So the derivation lives here and the callers cannot express the broken state.

import { sanitizeContent } from './sanitize.ts';
import { normalizeTitle, TITLE_NORMALIZED_VERSION } from './titleFilterCore.ts';
import type { ParsedFeed } from './parser.ts';

type ParsedItem = ParsedFeed['items'][number];

/** One row of the `upsert_feed_items` payload (feed_id is passed separately as
 * the RPC's `p_feed_id`). */
export interface ItemRow {
  guid: string;
  url: string | null;
  comments_url: string | null;
  title: string | null;
  title_normalized: string;
  title_normalized_version: number;
  author: string | null;
  published_at: string | null;
  content_html: string | null;
  summary: string | null;
  enclosures: unknown;
  content_hash: string;
}

/** Map a parsed item to its stored row. `siteUrl` is the feed's own site, used
 * to absolutize relative links when the item carries no URL of its own. */
export function toItemRow(it: ParsedItem, siteUrl: string | null): ItemRow {
  const base = it.url ?? siteUrl;
  return {
    guid: it.guid,
    url: it.url,
    comments_url: it.commentsUrl,
    title: it.title,
    // Derived from the same `title` on the same line, so the two cannot drift.
    // normalizeTitle applies the client's `(untitled)` fallback for a null
    // title, so both sides see the same text for an untitled row.
    title_normalized: normalizeTitle(it.title),
    title_normalized_version: TITLE_NORMALIZED_VERSION,
    author: it.author,
    published_at: it.publishedAt,
    // SANITIZE every body before storing (guardrail #6).
    content_html: sanitizeContent(it.contentHtml, base),
    // The summary is publisher HTML too (RSS <description>, Atom
    // <summary type="html">) — never stored raw. Null (no distinct summary)
    // survives; sanitizeContent would collapse it to ''.
    summary: it.summary == null ? null : sanitizeContent(it.summary, base),
    enclosures: it.enclosures,
    // content_hash detects edits → update in place rather than duplicate.
    content_hash: it.guid,
  };
}
