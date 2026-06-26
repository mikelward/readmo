// Find the Hacker News discussion for an article URL, so the reader can link
// out to it. Readmo itself has no comments (SPEC.md *Guiding differences* #3),
// but most of what people read still gets discussed on HN — and HN's public
// Algolia index lets us look that discussion up by URL, for ANY feed, not just
// the HN feed. We resolve the matching story id and hand the reader off to its
// sibling app *newshacker* (a reader for Hacker News) at `/item/:id`.
//
// Cost & reliability (guardrail #5): the only call is to HN's Algolia API
// (`hn.algolia.com`) — free, keyless, no quota that signup-scale traffic
// approaches; the same index newshacker already searches. It's a fixed,
// trusted host queried with a string (not a user-supplied URL we fetch), so it
// needs no SSRF hardening. On any failure (offline, non-2xx, malformed JSON,
// no confident match) we return null and the reader simply shows no comments
// icon — never a dead link. **Negligible** cost; degrades to today's behavior.

import { isSafeHttpUrl } from './itemMeta';
import { looksTokenized } from './urlSafety';

/** A resolved HN discussion for an article. */
export interface HnDiscussion {
  /** The HN story id — the `/item/:id` key shared by HN, Algolia, and
   * newshacker. */
  id: string;
  /** Comment count at lookup time (informational; the icon shows no number). */
  numComments: number;
}

/** Origin of the newshacker deployment the comments icon links into. Overridable
 * for self-hosted forks via `VITE_NEWSHACKER_ORIGIN`; defaults to production. */
export const NEWSHACKER_ORIGIN: string = normalizeOrigin(
  import.meta.env.VITE_NEWSHACKER_ORIGIN,
);

function normalizeOrigin(raw: string | undefined): string {
  const fallback = 'https://newshacker.app';
  if (!raw) return fallback;
  const trimmed = raw.replace(/\/+$/, '');
  return isSafeHttpUrl(trimmed) ? trimmed : fallback;
}

/** The newshacker thread (= HN comments) URL for a story id. */
export function newshackerThreadUrl(id: string): string {
  return `${NEWSHACKER_ORIGIN}/item/${encodeURIComponent(id)}`;
}

const ALGOLIA_SEARCH = 'https://hn.algolia.com/api/v1/search';

/** Tracking/share params that don't change which page a URL identifies; dropped
 * before comparing the article URL against Algolia's stored submission URL. */
function isNoiseParam(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.startsWith('utm_') ||
    ['ref', 'ref_src', 'cmpid', 'spm', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(k)
  );
}

/** Canonicalize a URL for equality: lowercase host, drop `www.` and a trailing
 * slash, ignore scheme/fragment, and strip tracking params (sorted remainder).
 * Returns null for anything that isn't a parseable http(s) URL. Two URLs that
 * canonicalize equal point at the same article for discussion-matching. */
export function canonicalizeForMatch(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '');
  const params = new URLSearchParams(parsed.search);
  for (const key of [...params.keys()]) {
    if (isNoiseParam(key)) params.delete(key);
  }
  params.sort();
  const query = params.toString();
  return host + (path || '') + (query ? `?${query}` : '');
}

interface AlgoliaHit {
  objectID?: string;
  url?: string | null;
  num_comments?: number | null;
  points?: number | null;
}

/**
 * Resolve the HN discussion for an article URL via Algolia's `restrictSearchable
 * Attributes=url` search, then verify each candidate's stored URL canonicalizes
 * to the same page (Algolia tokenizes URLs, so the raw query alone over-matches).
 * Of the verified submissions, pick the one with the most comments (ties broken
 * by points) — the canonical discussion when a URL was submitted more than once.
 * Returns null on no match or any failure.
 */
export async function findHnDiscussion(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HnDiscussion | null> {
  const wanted = canonicalizeForMatch(url);
  if (!wanted) return null;

  // Never forward a possibly-tokenized article URL to the third-party index — a
  // per-item URL from a private/tokenized feed can embed a subscriber secret in
  // its path (query strings are already dropped by canonicalization, but this
  // also catches token-in-path). Mirrors the full-text path's Jina gate
  // (supabase/functions/fulltext) — guardrail #6/#7.
  if (looksTokenized(url)) return null;

  const params = new URLSearchParams({
    query: url,
    restrictSearchableAttributes: 'url',
    tags: 'story',
    hitsPerPage: '20',
  });

  let hits: AlgoliaHit[];
  try {
    const res = await fetchImpl(`${ALGOLIA_SEARCH}?${params.toString()}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { hits?: AlgoliaHit[] };
    hits = Array.isArray(body.hits) ? body.hits : [];
  } catch {
    return null;
  }

  let best: { id: string; numComments: number; points: number } | null = null;
  for (const hit of hits) {
    if (!hit.objectID || !hit.url) continue;
    if (canonicalizeForMatch(hit.url) !== wanted) continue;
    const numComments = hit.num_comments ?? 0;
    const points = hit.points ?? 0;
    if (
      !best ||
      numComments > best.numComments ||
      (numComments === best.numComments && points > best.points)
    ) {
      best = { id: hit.objectID, numComments, points };
    }
  }

  return best ? { id: best.id, numComments: best.numComments } : null;
}
