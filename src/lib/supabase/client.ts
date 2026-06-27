import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { setConnectivityProbeUrl, trackedFetch } from '../networkStatus';
import { buildInfo } from '../buildInfo';
import { RequestCircuitBreaker } from '../data/requestCircuitBreaker';

// Hard ceiling on a single PostgREST GET read. Without it a request that never
// answers (lie-fi, or the service worker's NetworkFirst awaiting a hung network
// on a cache miss) leaves the read pending forever — and because
// SupabaseDataSource memoizes the in-flight item_state hydration, one hung read
// wedges the whole feed on its loading skeletons. Timing out rejects the read
// instead, so React Query can surface the offline/retry UI and retry on
// reconnect. 8s sits just past the SW's 6s cache-fallback window
// (`networkTimeoutSeconds` in vite.config.ts) so a genuinely slow-but-working
// read still gets served from cache first — keep the two in lockstep (cap >
// window) if either moves. A single page fetch hanging now clears in ~8s rather
// than the old 15s, so stuck skeletons / a queued-behind hydration recover
// faster without aborting a read the cache could still answer.
//
// The cap is scoped to reads — GET on /rest/v1/ plus the feed_items read RPC
// (see isBoundedRead) — deliberately NOT applied to writes (the outbox owns
// their durability/retry), auth (a timed-out refresh would null the user →
// spurious sign-out + cache purge), or Edge Functions (legitimately
// long-running). All of those still flow through trackedFetch, so a real failure
// flips the Offline pill.
const REQUEST_TIMEOUT_MS = 8_000;

// Single browser Supabase client for the whole app. The URL + anon key are
// public (RLS-gated); the service-role key never reaches the client. When the
// env vars are absent (tests, backend-less local/mock dev) the app falls back
// to the mock auth + MockDataSource path, so this module never throws at import
// time — only `getSupabase()` throws, and only if actually called unconfigured.

// Accept our own VITE_* names first, then fall back to the public names the
// Supabase↔Vercel integration provisions (NEXT_PUBLIC_*), so deployments wired
// through that integration work without hand-duplicating env vars. Only public
// keys are read here — never the service-role/secret keys.
const env = import.meta.env;
const url = env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey =
  env.VITE_SUPABASE_ANON_KEY ??
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Register the reachability probe used to disambiguate a read *timeout* from
// genuine offline (see networkStatus.ts). GoTrue's `/auth/v1/health` is an
// in-process liveness check that doesn't query Postgres, so it stays responsive
// even when the DB is overloaded — the case where a slow `feed_items` read would
// otherwise time out and paint a wrong "Offline" pill. Unconfigured (mock) →
// no probe, and a timeout falls back to being treated as offline.
setConnectivityProbeUrl(url ? `${url.replace(/\/$/, '')}/auth/v1/health` : null);

/** Deterministic localStorage key for the persisted auth session. Fixed (rather
 * than supabase-js's default `sb-<ref>-auth-token`) so the boot path can read
 * the signed-in uid synchronously, before first paint — see getActiveUid. */
export const AUTH_STORAGE_KEY = 'readmo:sb-auth';

/** True when both client env vars are present. Drives the auth + data-source
 * selection: configured → real Supabase; unconfigured → mock. */
export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}

/** The request URL as a string, across the `Request | string | URL` shapes the
 * global fetch accepts. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The HTTP method, across the `Request | string | URL` + init shapes the
 * global fetch accepts. Defaults to GET (the fetch default). */
function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

// PostgREST sends `rpc()` as a POST, so read-only RPCs can't be recognized by
// method — list them explicitly. These are pure reads (safe to abort + retry
// like any GET) and so get the read timeout AND the read breaker:
//   - feed_items — the primary feed read (home/folder/feed); a hung one strands
//     the view on its skeletons even when item_state is cached.
//   - feed_unread_counts — the grouped-view per-feed unread counts; a failing
//     grouped refetch/invalidation loop hits this, so it must be shed by the
//     breaker too, not just feed_items.
// Write RPCs (set_item_state, subscribe_to_feed, reorder_subscriptions) are
// deliberately ABSENT — see isBoundedRead.
const READ_RPC_PATHS = [
  '/rest/v1/rpc/feed_items',
  '/rest/v1/rpc/feed_unread_counts',
];

/**
 * The requests that get the short cap: **GET reads** on PostgREST (`/rest/v1/`)
 * — the path the service worker mediates (Workbox runtime caching is GET-only),
 * so the cache-miss-hang this targets is a GET — plus the known read-only RPCs
 * (`feed_items`), which are POSTs but idempotent reads. Everything else is left
 * uncapped:
 *   - Write RPCs (POST `rpc/set_item_state`, `rpc/subscribe_to_feed`) and table
 *     writes (DELETE/PATCH on `subscriptions`) share the `/rest/v1/` prefix but
 *     must NOT be aborted mid-commit — the item-state outbox treats an 8s abort
 *     as a transient failure and retries on a stale base version (risking a
 *     permanent conflict / dropped edit), and a subscription edit could surface
 *     an error even though the server committed. The outbox's own
 *     retry/durability is the right bound for writes.
 *   - Auth (`/auth/v1/`) and Edge Function (`/functions/v1/`) requests — see the
 *     constant's note.
 */
function isBoundedRead(input: RequestInfo | URL, init?: RequestInit): boolean {
  const u = requestUrl(input);
  if (READ_RPC_PATHS.some((path) => u.includes(path))) return true;
  return requestMethod(input, init) === 'GET' && u.includes('/rest/v1/');
}

/**
 * The bounded reads the circuit breaker guards: the **network-authoritative**
 * ones — a subset of {@link isBoundedRead} the service worker never answers from
 * cache. The breaker's half-open probe must be network-authoritative: its result
 * decides whether the backend recovered, so a response that didn't reach the
 * backend would close the circuit on a lie. Two kinds qualify:
 *
 *   1. The read-only RPCs (`feed_items`, `feed_unread_counts`) — POSTs, and the
 *      SW's `NetworkFirst` runtime cache is GET-only (`vite.config.ts`), so it
 *      NEVER serves them from cache.
 *   2. The `item_state` hydration GET — served by the SW's **NetworkOnly** route
 *      (`vite.config.ts` `supabaseItemStatePattern`, registered before the
 *      NetworkFirst REST route), so it too always hits the backend. It precedes
 *      every feed read (`ensureHydratedForRead`), so a failing feed loop's
 *      hydration GET must be shed alongside the RPC, not bypass the breaker.
 *
 * Every OTHER GET `/rest/v1/` read is `NetworkFirst`-cached: it can be answered
 * from a stale Workbox cache (a `200` the backend never saw), so it keeps the read
 * *timeout* (a hung GET must still abort) but bypasses the *breaker* — letting a
 * cached `200` probe close the circuit would falsely recover it mid-outage. A
 * failing cacheable-GET loop is already bounded by the retry discipline
 * (`queryRetry.ts`, no 4xx/5xx retries) plus NetworkFirst's own cache fallback;
 * a *succeeding* high-rate loop is the gateway's job (SCALING.md), which the
 * failure-based breaker never caught anyway.
 *
 * (Keep the item_state path in sync with `supabaseItemStatePattern` in
 * vite.config.ts — both encode that item_state is the NetworkOnly read.)
 */
function isBreakerScopedRead(input: RequestInfo | URL, init?: RequestInit): boolean {
  const u = requestUrl(input);
  if (READ_RPC_PATHS.some((path) => u.includes(path))) return true;
  return requestMethod(input, init) === 'GET' && u.includes('/rest/v1/item_state');
}

/**
 * Connectivity-tracking fetch for the Supabase client. Every request flows
 * through {@link trackedFetch} so a real failure flips the offline indicator.
 * Reads (GET on `/rest/v1/`, plus the `feed_items` read RPC) additionally get a
 * {@link REQUEST_TIMEOUT_MS} ceiling so a hung connection rejects rather than
 * hanging the read forever; writes, auth, and Edge Function invocations are left
 * uncapped (see {@link isBoundedRead}). A caller-supplied signal (e.g. React
 * Query cancelling a superseded query) still aborts; the timeout adds a second
 * abort reason without clobbering it.
 */
// Client-side flood guard for the network-authoritative bounded reads — the read
// RPCs (feed_items, feed_unread_counts) and the NetworkOnly item_state hydration
// GET that precedes every feed read (see isBreakerScopedRead). A failing loop
// trips the breaker after a burst of failures and is SHED, failing fast instead
// of pinning Postgres. Healthy bursts (e.g. a large offline warmup) never trip it
// — it's failure-based, not rate-based. The additive backstop behind the retry
// discipline (src/lib/queryRetry.ts); the server-side `x-readmo-build` gate sheds
// a known-bad *build*, this caps a failing loop in the live build. NetworkFirst-
// cached GET /rest/v1/ reads keep the read timeout but bypass the breaker (a cache
// fallback isn't a backend-liveness signal — see isBreakerScopedRead); writes
// (outbox-owned), auth, Edge Functions, storage and realtime bypass it too — see
// supabaseFetch for why.
let requestBreaker = new RequestCircuitBreaker();

/** Test-only: reset the module-level breaker between cases (it's a singleton). */
export function _resetRequestBreakerForTests(): void {
  requestBreaker = new RequestCircuitBreaker();
}

/** A caller/cancellation abort — surfaced as an AbortError (DOMException OR a
 * plain Error named 'AbortError', runtime dependent), distinct from a
 * TimeoutError. Not a backend-health signal. */
function isAbortError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

// Any error response counts as a breaker FAILURE. The breaker is scoped to the
// network-authoritative reads (the read RPCs + the item_state hydration GET; see
// isBreakerScopedRead), which return 2xx in normal use — so a 4xx is NOT a benign
// app response here: a PostgREST 404 (the feed_items/feed_unread_counts function
// missing on a stale or schema-mismatched backend), 400, or 422 is a genuinely
// failed read that a refetch loop would otherwise repeat forever without ever
// tripping the circuit. So only 2xx/3xx is healthy; 4xx and 5xx (including
// 401/403/408/429) count as failures.
function isHealthyResponse(status: number): boolean {
  return status < 400;
}

function boundedReadFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal ?? undefined;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException('Supabase request timed out', 'TimeoutError'),
      ),
    REQUEST_TIMEOUT_MS,
  );
  return trackedFetch(input, { ...init, signal: controller.signal }).finally(
    () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    },
  );
}

export function supabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Everything that isn't a bounded read is uncapped exactly as before — no read
  // timeout, no breaker:
  //   - WRITES (rpc/set_item_state, rpc/subscribe_to_feed, subscription
  //     PATCH/DELETE) are owned by the item-state outbox (its own backoff +
  //     durability); shedding one would surface a spurious local failure on a
  //     subscription edit and just delay outbox delivery.
  //   - AUTH (/auth/v1/) must stay reachable to refresh/sign-out and recover an
  //     expired-token storm — exactly when the breaker is open — as must the
  //     /auth/v1/health connectivity probe. Edge Functions/storage/realtime too.
  if (!isBoundedRead(input, init)) {
    return trackedFetch(input, init);
  }

  // A bounded read. It always gets the 8s timeout, but only the network-
  // authoritative reads go through the breaker — the read RPCs (POSTs the GET-only
  // SW cache never serves) and the item_state hydration GET (a NetworkOnly route).
  // Every other GET /rest/v1/ read is NetworkFirst-cached, so a stale cache `200`
  // could falsely close the breaker mid-outage; those bypass it (see
  // isBreakerScopedRead).
  if (!isBreakerScopedRead(input, init)) {
    return boundedReadFetch(input, init);
  }

  const ticket = requestBreaker.shouldAllow();
  if (ticket === null) {
    // Not admitted. Two cases:
    const probeWait = requestBreaker.probeWait();
    if (probeWait) {
      // Half-open: a single probe is in flight. HOLD this peer read until the
      // probe settles, then re-decide — rather than failing it now and relying
      // on its (short) retry budget to outlast a healthy-but-slow probe. The
      // wait is bounded by the probe's own 8s read cap, and on re-entry it's
      // admitted (probe closed the circuit) or shed (probe re-opened it).
      return probeWait.then(() => supabaseFetch(input, init));
    }
    // Open + cooling down: shed with a RETRIABLE statusless error (queryRetry
    // treats it as a transient blip — NOT an AbortError) so a real outage fails
    // fast but recovers on the next refetch. Sheds never reach the network, so
    // retrying them adds no DB load.
    return Promise.reject(
      new Error('Supabase request shed: backend circuit open'),
    );
  }
  return boundedReadFetch(input, init).then(
    (res) => {
      requestBreaker.settle(ticket, isHealthyResponse(res.status));
      return res;
    },
    (err) => {
      // A caller/cancellation abort (e.g. React Query superseding a query via
      // the forwarded signal) is neither a failure nor a success; settleCanceled
      // records it as such and re-arms a canceled half-open probe so the breaker
      // can't get stuck. Our own shed returns before the fetch and the read
      // timeout aborts with TimeoutError (a real failure), so AbortError here is
      // always a caller cancel.
      if (isAbortError(err)) requestBreaker.settleCanceled(ticket);
      else requestBreaker.settle(ticket, false);
      throw err;
    },
  );
}

let client: SupabaseClient | null = null;

/** The shared client. Throws if called while unconfigured — callers gate on
 * `isSupabaseConfigured()` first. */
export function getSupabase(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured: set VITE_SUPABASE_URL and ' +
        'VITE_SUPABASE_ANON_KEY (see .env.example).',
    );
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Complete the OAuth redirect: parse the session from the URL on the
        // landing load.
        detectSessionInUrl: true,
        storageKey: AUTH_STORAGE_KEY,
      },
      // Connectivity-track every request and bound reads (GET + feed_items RPC)
      // so a hung network can't strand a read on its loading skeletons forever
      // (writes/auth/functions stay uncapped — see supabaseFetch).
      //
      // Stamp the build number on every request so the backend can shed an old
      // client shipped with a runaway-refetch bug: the Edge functions gate on
      // it (supabase/functions/_shared/clientVersion.ts) and a gateway can gate
      // the read RPC the same way. Header name is duplicated as a literal here
      // because src/ and supabase/functions/ build separately — keep it in sync
      // with CLIENT_BUILD_HEADER ('x-readmo-build').
      global: {
        fetch: supabaseFetch,
        headers: { 'x-readmo-build': String(buildInfo.commitCount) },
      },
    });
  }
  return client;
}
