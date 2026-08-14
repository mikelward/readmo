// Per-user partitioning of the Workbox runtime caches (guardrail #8). The
// caches used to be single, shared buckets ('readmo-data', …) — so on a
// shared device one user's cached REST responses sat where the next user's
// service worker would serve them offline, and a departing session's
// in-flight request could repopulate the bucket AFTER the sign-out purge
// (Codex P1 on #436). Partitioning by user makes that class structurally
// impossible: every account reads and writes only its own bucket, and a dying
// session's late write lands in the bucket nobody else reads.
//
// This module is shared by the service worker (src/sw.ts), the purge helpers
// (lib/userCache.ts), and the page-side announce below — it must stay free of
// DOM/React imports so the SW build can use it.

/** Base names of the per-user runtime caches. The fonts cache stays a single
 * shared bucket — typeface bytes carry no user signal. */
export const WORKBOX_RUNTIME_CACHE_BASES = [
  'readmo-data',
  'readmo-images',
  'readmo-favicons',
] as const;

/** The cache bucket for `base` scoped to a user (or the anonymous scope when
 * signed out). Uids are Supabase UUIDs / mock ids — safe in cache names. */
export function scopedWorkboxCacheName(
  base: string,
  uid: string | null,
): string {
  return `${base}:${uid ?? 'anon'}`;
}

/** Whether `name` is one of our runtime cache buckets — a scoped one
 * (`readmo-data:<uid>`) or a legacy unscoped one from a pre-partitioning
 * client (`readmo-data`). Used by the wholesale sweep. */
export function isRuntimeWorkboxCache(name: string): boolean {
  return WORKBOX_RUNTIME_CACHE_BASES.some(
    (base) => name === base || name.startsWith(`${base}:`),
  );
}

/** The `sub` claim of a Bearer JWT from an Authorization header value, or
 * null. This is BUCKETING, not authentication — the server verifies the
 * token; we only need a stable per-user partition key, and the token the
 * request itself carries is race-proof in a way an ambient "current user"
 * value is not: a departing session's late request buckets by its OWN
 * credential. Supabase's anon key is a JWT without a `sub`, so signed-out
 * reads fall through to null (the announced/anon scope). */
export function jwtSubject(authorization: string | null): string | null {
  if (!authorization) return null;
  const token = authorization.replace(/^Bearer\s+/i, '');
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { sub?: unknown };
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

/** Matches Supabase REST/RPC reads for the data cache. Derived from the
 * configured Supabase origin so it keeps matching after a gateway migration —
 * pointing VITE_SUPABASE_URL at e.g. api.readmo.app would otherwise silently
 * drop the offline cache. Falls back to any project ref when the URL is unset
 * (local dev, .env-only setups). */
export function supabaseRestCachePattern(url: string | undefined): RegExp {
  if (url) {
    try {
      const host = new URL(url).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^https://${host}/rest/v1/.*`);
    } catch {
      // Malformed URL — fall through to the default below.
    }
  }
  return /^https:\/\/.*\.supabase\.co\/rest\/v1\/.*/;
}

/** Matches the `item_state` PostgREST reads, served NetworkOnly (no cache
 * fallback) so item-state hydration is always live-or-fail. This keeps a
 * focus/online cross-device resync from reconciling the local store against a
 * stale cached snapshot, and keeps an offline cold boot from dropping a
 * resync-adopted row — offline the read simply fails and the store keeps its
 * last-good localStorage state. Registered BEFORE the general NetworkFirst
 * REST route so it wins (Workbox: first match). */
export function supabaseItemStatePattern(url: string | undefined): RegExp {
  if (url) {
    try {
      const host = new URL(url).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^https://${host}/rest/v1/item_state(\\?.*)?$`);
    } catch {
      // Malformed URL — fall through to the default below.
    }
  }
  return /^https:\/\/.*\.supabase\.co\/rest\/v1\/item_state(\?.*)?$/;
}

/** The message the page sends the service worker to scope the request-side
 * caches that carry no credential of their own (the same-origin image/favicon
 * proxies). Data reads don't need it — they bucket by their own JWT. */
export const SW_SET_UID_MESSAGE = 'readmo:active-uid';

/**
 * Header the service worker stamps on every Supabase REST read it handles,
 * saying what became of the network attempt. `NetworkFirst` hides that by
 * design — a cache fallback and a live read both arrive as a plain `200` — and
 * the client breaker (`src/lib/supabase/client.ts`) needs to tell them apart in
 * both directions: a fallback for a *failed* request is an outage disguised as
 * health, and a live read is the authoritative success that ends probation.
 *
 * **Absence means "unknown", never "network-served".** A service worker cached
 * before this build shipped stamps nothing, and an old SW can outlive many
 * client deploys, so the client keeps its unstamped behavior for those.
 */
export const SW_SOURCE_HEADER = 'x-readmo-sw-source';

/**
 * What became of the network attempt behind a read — see
 * {@link SW_SOURCE_HEADER}.
 *
 *  - `network`      — the backend itself answered. Authoritative.
 *  - `cache-error`  — the request FAILED and the cache answered instead. This is
 *                     the shape a connection-refused outage takes, and the only
 *                     fallback that is evidence about backend health.
 *  - `cache-timeout`— the cache answered because the request outran
 *                     `networkTimeoutSeconds`, while it was still in flight. A
 *                     slow backend is not a failed one, and the request may well
 *                     succeed a moment later where nothing can see it, so this
 *                     must stay inconclusive: counting it would let one slow
 *                     screen-load's worth of concurrent reads open the circuit.
 */
export type SwSource = 'network' | 'cache-error' | 'cache-timeout';

/**
 * Copy `response` with the {@link SW_SOURCE_HEADER} stamp added. Header only:
 * body, status and every other header are preserved, so nothing downstream
 * changes shape.
 *
 * A copy rather than a mutation because a `Response` from the Cache API has
 * immutable headers — setting one in place throws, which on the cache-fallback
 * path is precisely the offline read we must not break.
 */
export function stampSwSource(response: Response, source: SwSource): Response {
  const stamped = new Response(response.body, response);
  stamped.headers.set(SW_SOURCE_HEADER, source);
  return stamped;
}

/** Tell the (current and future) service worker which user's cache buckets
 * the uncredentialed proxy requests belong to. Fire-and-forget from boot:
 * the SW also persists the value itself, so a restarted worker recovers it
 * without a page round-trip; until the very first announce lands, requests
 * bucket to the anonymous scope, which only costs offline warmth. */
export function announceUidToServiceWorker(uid: string | null): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  try {
    const message = { type: SW_SET_UID_MESSAGE, uid };
    navigator.serviceWorker.controller?.postMessage(message);
    // First visit / new registration: no controller yet — deliver once the
    // registration is active so the first session still gets scoped buckets.
    void navigator.serviceWorker.ready
      .then((registration) => registration.active?.postMessage(message))
      .catch(() => {});
  } catch {
    // Best-effort — a failed announce just leaves requests on the anon scope.
  }
}
