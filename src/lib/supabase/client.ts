import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { setConnectivityProbeUrl, trackedFetch } from '../networkStatus';

// Hard ceiling on a single PostgREST GET read. Without it a request that never
// answers (lie-fi, or the service worker's NetworkFirst awaiting a hung network
// on a cache miss) leaves the read pending forever — and because
// SupabaseDataSource memoizes the in-flight item_state hydration, one hung read
// wedges the whole feed on its loading skeletons. Timing out rejects the read
// instead, so React Query can surface the offline/retry UI and retry on
// reconnect. 15s sits just past the SW's 10s cache-fallback window so a
// genuinely slow-but-working read still gets served from cache first.
//
// The cap is scoped to reads — GET on /rest/v1/ plus the feed_items read RPC
// (see isBoundedRead) — deliberately NOT applied to writes (the outbox owns
// their durability/retry), auth (a timed-out refresh would null the user →
// spurious sign-out + cache purge), or Edge Functions (legitimately
// long-running). All of those still flow through trackedFetch, so a real failure
// flips the Offline pill.
const REQUEST_TIMEOUT_MS = 15_000;

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
// like any GET), and `feed_items` is the primary feed read (home/folder/feed),
// so it must be bounded too or a hung feed RPC still strands the view on its
// skeletons even when item_state is cached. Write RPCs (set_item_state,
// subscribe_to_feed) are deliberately ABSENT — see isBoundedRead.
const READ_RPC_PATHS = ['/rest/v1/rpc/feed_items'];

/**
 * The requests that get the short cap: **GET reads** on PostgREST (`/rest/v1/`)
 * — the path the service worker mediates (Workbox runtime caching is GET-only),
 * so the cache-miss-hang this targets is a GET — plus the known read-only RPCs
 * (`feed_items`), which are POSTs but idempotent reads. Everything else is left
 * uncapped:
 *   - Write RPCs (POST `rpc/set_item_state`, `rpc/subscribe_to_feed`) and table
 *     writes (DELETE/PATCH on `subscriptions`) share the `/rest/v1/` prefix but
 *     must NOT be aborted mid-commit — the item-state outbox treats a 15s abort
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
 * Connectivity-tracking fetch for the Supabase client. Every request flows
 * through {@link trackedFetch} so a real failure flips the offline indicator.
 * Reads (GET on `/rest/v1/`, plus the `feed_items` read RPC) additionally get a
 * {@link REQUEST_TIMEOUT_MS} ceiling so a hung connection rejects rather than
 * hanging the read forever; writes, auth, and Edge Function invocations are left
 * uncapped (see {@link isBoundedRead}). A caller-supplied signal (e.g. React
 * Query cancelling a superseded query) still aborts; the timeout adds a second
 * abort reason without clobbering it.
 */
export function supabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!isBoundedRead(input, init)) return trackedFetch(input, init);

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
      global: { fetch: supabaseFetch },
    });
  }
  return client;
}
