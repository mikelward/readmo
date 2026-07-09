/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa `injectManifest`). This replaces the
// old declarative `generateSW` config for ONE reason: the runtime caches are
// partitioned per user (guardrail #8), and picking a cache bucket per request
// needs code. Everything else — precache, navigation fallback, autoUpdate
// semantics (skipWaiting + clientsClaim), the strategies and their caps —
// reproduces what generateSW emitted before.
//
// Bucketing rules:
//  - Supabase REST reads bucket by the `sub` claim of the JWT the request
//    itself carries. That's race-proof: a departing session's in-flight
//    request lands in ITS OWN bucket regardless of who is signed in by the
//    time it settles — the leak class Codex flagged on #436 (a late response
//    repopulating a shared cache after the sign-out purge) can't happen.
//  - The same-origin image/favicon proxies carry no credential, so they
//    bucket by the uid the page announces at boot (persisted here in
//    IndexedDB so a restarted worker recovers it without a page round-trip).
//  - Fonts stay a single shared bucket — typeface bytes carry no user signal.
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, NetworkOnly } from 'workbox-strategies';
import type { Strategy } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import {
  jwtSubject,
  scopedWorkboxCacheName,
  supabaseItemStatePattern,
  supabaseRestCachePattern,
  SW_SET_UID_MESSAGE,
  WORKBOX_RUNTIME_CACHE_BASES,
} from './lib/swScope';

declare let self: ServiceWorkerGlobalScope;

// autoUpdate semantics: a newly-installed SW activates immediately and claims
// open tabs (the page's update watcher reloads on controllerchange).
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Offline navigation to /pinned, /item/:id, etc. resolves to the precached
// shell and React Router takes over.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  }),
);

// ---------------------------------------------------------------------------
// Announced-uid persistence (for the uncredentialed proxy routes).
// ---------------------------------------------------------------------------

const UID_DB = 'readmo-sw';
const UID_STORE = 'kv';
const UID_KEY = 'active-uid';

function openUidDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(UID_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(UID_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readPersistedUid(): Promise<string | null> {
  return openUidDb().then(
    (db) =>
      new Promise<string | null>((resolve) => {
        const tx = db.transaction(UID_STORE, 'readonly');
        const get = tx.objectStore(UID_STORE).get(UID_KEY);
        get.onsuccess = () =>
          resolve(typeof get.result === 'string' ? get.result : null);
        get.onerror = () => resolve(null);
      }),
    () => null,
  );
}

function persistUid(uid: string | null): void {
  void openUidDb().then(
    (db) => {
      const tx = db.transaction(UID_STORE, 'readwrite');
      if (uid === null) tx.objectStore(UID_STORE).delete(UID_KEY);
      else tx.objectStore(UID_STORE).put(uid, UID_KEY);
    },
    () => {},
  );
}

// In-memory current uid; `undefined` = not yet loaded from IndexedDB.
let announcedUid: string | null | undefined;

async function getAnnouncedUid(): Promise<string | null> {
  if (announcedUid !== undefined) return announcedUid;
  const persisted = await readPersistedUid();
  // A page announce can land WHILE the IndexedDB read is in flight (a fresh
  // worker's first proxy fetch races the boot message). The announce is
  // fresher than anything persisted — an account switch or sign-out may have
  // happened since — so adopt the persisted value only if nothing else set
  // the uid meanwhile (Codex P1 on #438).
  if (announcedUid === undefined) announcedUid = persisted;
  return announcedUid;
}

self.addEventListener('message', (event) => {
  const data = event.data as { type?: unknown; uid?: unknown } | null;
  if (!data || data.type !== SW_SET_UID_MESSAGE) return;
  const uid = typeof data.uid === 'string' && data.uid ? data.uid : null;
  announcedUid = uid;
  persistUid(uid);
});

// ---------------------------------------------------------------------------
// Runtime routes.
// ---------------------------------------------------------------------------

// Same resolution order as lib/supabase/client.ts: our own VITE_ var first,
// then the NEXT_PUBLIC_ one the Supabase↔Vercel integration provisions.
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ||
  import.meta.env.NEXT_PUBLIC_SUPABASE_URL) as string | undefined;

// Self-hosted typeface woff2 (Fontsource, hashed into /assets). The precache
// glob omits woff2, so without this the active font would 404 offline and
// fall back to the system stack. CacheFirst, cache-on-use.
registerRoute(
  ({ url }) => /\/assets\/.*\.woff2$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'readmo-fonts',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 365 * 24 * 60 * 60,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// item_state reads — NetworkOnly (no cache fallback) so item-state hydration
// is always live-or-fail and never reconciles the store against a stale
// cached snapshot. MUST be registered before the NetworkFirst REST route
// (Workbox: first match).
const itemStatePattern = supabaseItemStatePattern(SUPABASE_URL);
registerRoute(({ url }) => itemStatePattern.test(url.href), new NetworkOnly());

// One strategy instance per cache bucket, created lazily and memoized —
// ExpirationPlugin state is per instance, and buckets are unbounded in name
// space but tiny in practice (the accounts that used this device).
const strategies = new Map<string, Strategy>();

function bucketStrategy(
  base: (typeof WORKBOX_RUNTIME_CACHE_BASES)[number],
  uid: string | null,
  make: (cacheName: string) => Strategy,
): Strategy {
  const cacheName = scopedWorkboxCacheName(base, uid);
  let strategy = strategies.get(cacheName);
  if (!strategy) {
    strategy = make(cacheName);
    strategies.set(cacheName, strategy);
  }
  return strategy;
}

// Data reads from Supabase REST/RPC — NetworkFirst so a healthy network
// always wins, with a cache fallback offline. Bucketed by the REQUEST'S OWN
// JWT subject (see header comment); the announced uid only covers a read that
// somehow carries no token.
const restPattern = supabaseRestCachePattern(SUPABASE_URL);
registerRoute(
  ({ url }) => restPattern.test(url.href),
  async ({ request, event }) => {
    const uid =
      jwtSubject(request.headers.get('Authorization')) ??
      (await getAnnouncedUid());
    const strategy = bucketStrategy(
      'readmo-data',
      uid,
      (cacheName) =>
        new NetworkFirst({
          cacheName,
          // A slow-but-working read falls back to cache after 6s. Kept just
          // below supabaseFetch's REQUEST_TIMEOUT_MS (8s) so the cache
          // fallback fires before the app-level abort — move the two together
          // if either changes.
          networkTimeoutSeconds: 6,
          plugins: [
            new ExpirationPlugin({
              maxEntries: 200,
              maxAgeSeconds: 24 * 60 * 60,
            }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
          ],
        }),
    );
    return strategy.handle({ request, event });
  },
);

// Article images proxied through our same-origin /api/img endpoint —
// CacheFirst, capped. The bytes are content-addressed (the `?url=` fully
// determines them) and the proxy serves them `immutable`, so a cache hit must
// NOT re-hit the network. Doubles as the offline-image source.
registerRoute(
  ({ url }) => /\/api\/img(?:\?.*)?$/.test(url.pathname + url.search),
  async ({ request, event }) => {
    const strategy = bucketStrategy(
      'readmo-images',
      await getAnnouncedUid(),
      (cacheName) =>
        new CacheFirst({
          cacheName,
          plugins: [
            new ExpirationPlugin({
              maxEntries: 300,
              maxAgeSeconds: 7 * 24 * 60 * 60,
            }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
          ],
        }),
    );
    return strategy.handle({ request, event });
  },
);

// Favicons — CacheFirst, long TTL, capped.
registerRoute(
  ({ url }) => /\/api\/favicon(?:\?.*)?$/.test(url.pathname + url.search),
  async ({ request, event }) => {
    const strategy = bucketStrategy(
      'readmo-favicons',
      await getAnnouncedUid(),
      (cacheName) =>
        new CacheFirst({
          cacheName,
          plugins: [
            new ExpirationPlugin({
              maxEntries: 200,
              maxAgeSeconds: 30 * 24 * 60 * 60,
            }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
          ],
        }),
    );
    return strategy.handle({ request, event });
  },
);

// One-time migration from the pre-partitioning worker: the old shared,
// unscoped buckets ('readmo-data', …) could hold any past user's responses —
// delete them outright rather than adopting them into a scope they were never
// keyed to. (Scoped buckets are untouched.)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all(
      WORKBOX_RUNTIME_CACHE_BASES.map((base) =>
        caches.delete(base).catch(() => false),
      ),
    ),
  );
});
