// Per-user cache scoping (AGENTS guardrail #8). Derives the localStorage keys
// for the persisted React-Query blob and the item-state store from the
// signed-in user id, and purges a departing user's persisted data + named
// Workbox runtime caches, so a shared device never leaks one user's
// cached/private content to the next.
//
// PR1 keys against the mock-auth uid (see useAuth); the same surface keys
// against the real Supabase auth.uid() in PR2 with no call-site changes.

const RQ_CACHE_BASE = 'readmo:rq-cache';
const ITEM_STATE_BASE = 'readmo:item-state';
// The uid that last booted the app, so a boot can detect an account switch that
// completed via a full-page redirect/reload (no in-tab transition observed).
const LAST_UID_KEY = 'readmo:last-uid';

// The named Workbox runtime caches (see vite.config.ts runtimeCaching). These
// are not per-user prefixed yet, so a purge deletes them wholesale; the next
// user simply repopulates from the network under their own RLS.
const WORKBOX_CACHES = ['readmo-data', 'readmo-images', 'readmo-favicons'];

/** Persisted React-Query cache key for a user (base key when signed out). */
export function rqCacheKey(uid: string | null): string {
  return uid ? `${RQ_CACHE_BASE}:${uid}` : RQ_CACHE_BASE;
}

/** Item-state store key for a user (base key when signed out). */
export function itemStateKey(uid: string | null): string {
  return uid ? `${ITEM_STATE_BASE}:${uid}` : ITEM_STATE_BASE;
}

/**
 * Purge a user's persisted, on-device data: their keyed React-Query blob and
 * item-state store, plus the named Workbox runtime caches. Best-effort and
 * never throws — localStorage may be unavailable/denied, and the Cache API is
 * absent under jsdom/SSR.
 */
export async function clearUserCaches(uid: string | null): Promise<void> {
  try {
    window.localStorage.removeItem(rqCacheKey(uid));
    window.localStorage.removeItem(itemStateKey(uid));
  } catch {
    // ignore (storage unavailable/denied)
  }
  if (typeof caches !== 'undefined') {
    await Promise.all(
      WORKBOX_CACHES.map((name) => caches.delete(name).catch(() => false)),
    );
  }
}

function readLastUid(): string | null {
  try {
    return window.localStorage.getItem(LAST_UID_KEY);
  } catch {
    return null;
  }
}

/**
 * Boot-time reconciliation (call before first paint). If the app is booting as a
 * different user than last time — e.g. an OAuth/account switch that completed via
 * a full-page redirect, so no in-tab transition fired — purge the previous user's
 * persisted stores and the named Workbox runtime caches before rendering, so the
 * NetworkFirst data cache can't serve the previous user's REST responses offline.
 * Always records the current uid as last-seen.
 */
export async function reconcileUserCachesOnBoot(
  currentUid: string | null,
): Promise<void> {
  const last = readLastUid();
  if (last !== currentUid) {
    await clearUserCaches(last);
  }
  try {
    if (currentUid) window.localStorage.setItem(LAST_UID_KEY, currentUid);
    else window.localStorage.removeItem(LAST_UID_KEY);
  } catch {
    // ignore (storage unavailable/denied)
  }
}
