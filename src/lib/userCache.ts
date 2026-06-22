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
// Suffix SupabaseDataSource appends to the item-state key for its offline write
// outbox. Defined here so clearUserCaches purges queued mutations with the rest
// of a departing user's data (SPEC/AGENTS: the outbox is flushed-or-discarded on
// sign-out — leaving it would replay one user's writes under another's scope).
export const OUTBOX_SUFFIX = ':outbox';
// The uid that last booted the app, so a boot can detect an account switch that
// completed via a full-page redirect/reload (no in-tab transition observed).
const LAST_UID_KEY = 'readmo:last-uid';
// Set once the legacy (pre-scoping) global stores have been migrated into a
// user-scoped key, so the migration runs at most once.
const MIGRATED_KEY = 'readmo:cache-migrated';

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

/** Offline item-state outbox key for a user (item-state key + suffix). */
export function outboxKey(uid: string | null): string {
  return `${itemStateKey(uid)}${OUTBOX_SUFFIX}`;
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
    window.localStorage.removeItem(outboxKey(uid));
  } catch {
    // ignore (storage unavailable/denied)
  }
  if (typeof caches !== 'undefined') {
    await Promise.all(
      WORKBOX_CACHES.map((name) => caches.delete(name).catch(() => false)),
    );
  }
}

// Copy a legacy global store into its user-scoped key (only when the scoped key
// is empty, so we never clobber newer data), then remove the legacy key.
function moveKey(from: string, to: string): void {
  const value = window.localStorage.getItem(from);
  if (value === null) return;
  if (window.localStorage.getItem(to) === null) {
    window.localStorage.setItem(to, value);
  }
  window.localStorage.removeItem(from);
}

// One-time migration from the pre-scoping global keys. An existing install
// upgrading to the keyed layout has its pins/favorites/offline cache at the base
// keys; move them into the signed-in user's scope so they survive instead of
// being treated as a departing user's data to purge. Skipped while signed out
// (no uid to scope into) — it runs on the first signed-in boot instead.
function migrateLegacyCaches(currentUid: string | null): void {
  try {
    if (!currentUid || window.localStorage.getItem(MIGRATED_KEY)) return;
    moveKey(RQ_CACHE_BASE, rqCacheKey(currentUid));
    moveKey(ITEM_STATE_BASE, itemStateKey(currentUid));
    window.localStorage.setItem(MIGRATED_KEY, '1');
  } catch {
    // ignore (storage unavailable/denied)
  }
}

/**
 * Boot-time reconciliation (call before first paint). Two jobs:
 *   1. One-time migrate the legacy global stores into the current user's scope
 *      (so upgrading users don't lose pins/favorites/offline cache).
 *   2. If this boot's uid differs from the last recorded one — e.g. an account
 *      switch that completed via a full-page redirect, so no in-tab transition
 *      fired — purge the previous user's persisted stores + named Workbox caches
 *      before rendering, so the NetworkFirst data cache can't serve the previous
 *      user's REST responses offline.
 *
 * The sentinel is ABSENT only on the very first keyed boot; that case is treated
 * as first-run (no purge — there is no previous user), not as a departing
 * signed-out user. Afterwards it's always present ('' when signed out).
 */
export async function reconcileUserCachesOnBoot(
  currentUid: string | null,
): Promise<void> {
  migrateLegacyCaches(currentUid);

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LAST_UID_KEY);
  } catch {
    // ignore (storage unavailable/denied)
  }
  // First keyed boot (no sentinel): no previous user to purge.
  const last = raw === null ? currentUid : raw === '' ? null : raw;
  if (last !== currentUid) {
    await clearUserCaches(last);
  }
  try {
    window.localStorage.setItem(LAST_UID_KEY, currentUid ?? '');
  } catch {
    // ignore (storage unavailable/denied)
  }
}
