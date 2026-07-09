import { removeItem as idbRemoveItem } from './idbStorage';

// Per-user cache scoping (AGENTS guardrail #8). Derives the storage keys for the
// persisted React-Query blob (IndexedDB) and the item-state store (localStorage)
// from the signed-in user id, and purges a departing user's persisted data +
// named Workbox runtime caches, so a shared device never leaks one user's
// cached/private content to the next.
//
// PR1 keys against the mock-auth uid (see useAuth); the same surface keys
// against the real Supabase auth.uid() in PR2 with no call-site changes.

const RQ_CACHE_BASE = 'readmo:rq-cache';
// `:v2` orphans the pre-LWW persisted blobs (the item-state store still carried a
// `version` field and the outbox stored a base-version per entry; the LWW outbox
// stores a per-field action timestamp instead, an incompatible shape that an old
// entry would choke a replay on). Bumping the base key — the outbox key derives
// from it — discards both old blobs so the store re-hydrates clean from the
// server (which remains the source of truth for pins/favorites/done). See
// SPEC.md *Sync* and 0023_item_state_lww.sql.
const ITEM_STATE_BASE = 'readmo:item-state:v2';
// Collapsed feed-sections set (group-by-feed view, see useCollapsedFeeds). It's a
// single per-device key rather than uid-scoped — but it holds a *subscription-
// derived* list of feed ids, so on a shared device it must not survive an account
// change (guardrail #8). clearUserCaches purges it on every transition; the other
// per-device prefs (hide-on-scroll, sort, …) carry no user data and stay global.
export const COLLAPSED_FEEDS_KEY = 'readmo:collapsed-feeds';
// Suffix SupabaseDataSource appends to the item-state key for its offline write
// outbox. Defined here so clearUserCaches purges queued mutations with the rest
// of a departing user's data (SPEC/AGENTS: the outbox is flushed-or-discarded on
// sign-out — leaving it would replay one user's writes under another's scope).
export const OUTBOX_SUFFIX = ':outbox';
// The uid that last booted the app, so a boot can detect an account switch that
// completed via a full-page redirect/reload (no in-tab transition observed).
const LAST_UID_KEY = 'readmo:last-uid';
// Explicit sign-out marker: set by useAuth.signOut right before the auth
// session is torn down, consumed by useUserCacheScope when it handles the
// transition — or, if the tab reloaded/closed before that ran, by the next
// boot's reconcile, which finishes the purge then (Codex P2 on #434). It lives
// in localStorage (not sessionStorage) precisely so it survives that tab
// closure. Distinguishes the reader ACTUALLY signing out (purge the departing
// user's on-device data — guardrail #8) from the session merely dropping on
// its own (supabase-js clears it when a token refresh fails, which happens
// routinely OFFLINE): purging on the latter wiped the offline cache exactly
// when it was needed, even though the same account signs right back in.
const EXPLICIT_SIGNOUT_KEY = 'readmo:explicit-signout';
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

// The sign-out marker is a THREE-STATE flag tracking the sign-out episode's
// lifecycle, because its failure modes pull in opposite directions and must
// be told apart (Codex rounds on #434/#436):
//
//   - `pending` — Sign out was tapped and NO purge has completed yet. This
//     state NEVER expires: an explicit sign-out is owed a purge, however late
//     the device next wakes (a tab closed mid-sign-out, reopened days later).
//     While it stands, every transition/boot purges the departing user.
//   - `purged` — a purge HAS completed and no sign-in has happened since. A
//     tab from the sign-out may still be alive and re-writing keys, so
//     signed-out paths keep FULL-purging through a short grace; past the
//     grace it reads as absent — a completed-but-unsettled marker must not
//     turn a much-later token-refresh drop (routine offline) into a spurious
//     cache wipe, the exact bug the marker exists to prevent (#434).
//   - `reauthed` — a SIGN-IN happened after the purge, ending the episode for
//     the uid-scoped stores: a session drop within the remaining grace is the
//     new session's routine token blip, and full-purging on it wiped the
//     reauthenticated user's pins/offline cache (Codex round 8). Through the
//     rest of the grace this state only keeps sweeping the shared Workbox
//     caches (the surface the departed session's late requests can poison
//     across users — round 7), never the current user's stores.
//
// No path ever hard-clears an ACTIVE marker (any tab could be the wrong one
// to settle it — Codex round 5); markers die by stamp-after-purge + grace
// expiry, and inactive leftovers are swept on signed-in boots. The purge is
// idempotent, so overlapping re-purges are harmless.
const EXPLICIT_SIGNOUT_TTL_MS = 10 * 60 * 1000;

export type SignOutMarker = 'pending' | 'purged' | 'reauthed';

/** Record that the reader chose to sign out (vs. the session dropping on its
 * own). Called by useAuth.signOut before tearing the session down. */
export function markExplicitSignOut(): void {
  try {
    window.localStorage.setItem(EXPLICIT_SIGNOUT_KEY, `p:${Date.now()}`);
  } catch {
    // ignore (storage unavailable/denied)
  }
}

/** Record that a purge satisfying the sign-out marker has COMPLETED, moving
 * it `pending` → `purged` (re-stamping a purged marker just refreshes its
 * timestamp — harmless). Callers stamp only after `clearUserCaches` resolves,
 * so a tab killed mid-purge leaves the marker `pending` and the next boot
 * retries. */
export function markSignOutPurgeCompleted(): void {
  try {
    window.localStorage.setItem(EXPLICIT_SIGNOUT_KEY, `d:${Date.now()}`);
  } catch {
    // ignore (storage unavailable/denied)
  }
}

/** Record that a sign-in happened after the sign-out's purge, moving the
 * marker `purged` → `reauthed` while PRESERVING its original timestamp — the
 * grace stays anchored to the sign-out, so the shared-cache sweeps still end
 * ~10 minutes after it. No-op for pending/absent markers. */
export function markSignOutReauthed(): void {
  try {
    const raw = window.localStorage.getItem(EXPLICIT_SIGNOUT_KEY);
    if (raw === null || !raw.startsWith('d:')) return;
    window.localStorage.setItem(EXPLICIT_SIGNOUT_KEY, `r:${raw.slice(2)}`);
  } catch {
    // ignore (storage unavailable/denied)
  }
}

/** The sign-out marker's ACTIVE state, or null when absent/expired:
 * `pending` — a purge is owed (any age); `purged` — a purge completed
 * recently (within the grace), no sign-in since; `reauthed` — a sign-in
 * followed the purge (shared-cache sweeps only). Read-only. */
export function peekSignOutMarker(): SignOutMarker | null {
  try {
    const raw = window.localStorage.getItem(EXPLICIT_SIGNOUT_KEY);
    if (raw === null) return null;
    if (raw.startsWith('d:') || raw.startsWith('r:')) {
      const at = Number(raw.slice(2));
      if (Number.isNaN(at)) return null;
      if (Date.now() - at > EXPLICIT_SIGNOUT_TTL_MS) return null;
      return raw.startsWith('d:') ? 'purged' : 'reauthed';
    }
    // `p:<ts>` — and any legacy format ('1', a bare timestamp) from an older
    // client, which predates the purged state and so can't prove a purge
    // completed: treat as pending, erring toward honoring the sign-out.
    return 'pending';
  } catch {
    return null;
  }
}

/** Whether the sign-out marker is ACTIVE in either state. */
export function peekExplicitSignOut(): boolean {
  return peekSignOutMarker() !== null;
}

/** Drop an INACTIVE marker (expired `purged` leftovers) — the sweep signed-in
 * boots run so dead markers don't accumulate. Never called on an active
 * marker; those convert via {@link markSignOutPurgeCompleted} and expire. */
export function clearExplicitSignOut(): void {
  try {
    window.localStorage.removeItem(EXPLICIT_SIGNOUT_KEY);
  } catch {
    // ignore (storage unavailable/denied)
  }
}

/** Delete the named GLOBAL Workbox runtime caches (they are not per-user
 * prefixed yet — see WORKBOX_CACHES). Best-effort and never throws; the Cache
 * API is absent under jsdom/SSR. */
export async function clearWorkboxCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await Promise.all(
    WORKBOX_CACHES.map((name) => caches.delete(name).catch(() => false)),
  );
}

/**
 * Purge a user's persisted, on-device data: their keyed React-Query blob (now in
 * IndexedDB) and item-state store, plus the named Workbox runtime caches.
 * Best-effort and never throws — storage may be unavailable/denied, and the
 * Cache API is absent under jsdom/SSR.
 */
export async function clearUserCaches(uid: string | null): Promise<void> {
  try {
    // The React-Query blob lived in localStorage before it moved to IndexedDB;
    // remove the legacy copy too so an upgrading shared device doesn't strand a
    // departing user's cached content under the old key.
    window.localStorage.removeItem(rqCacheKey(uid));
    window.localStorage.removeItem(itemStateKey(uid));
    window.localStorage.removeItem(outboxKey(uid));
    // Global (not uid-scoped), but subscription-derived — purge it so a departing
    // user's collapsed feeds don't carry into the next account on a shared device.
    window.localStorage.removeItem(COLLAPSED_FEEDS_KEY);
  } catch {
    // ignore (storage unavailable/denied)
  }
  // The persisted React-Query cache (article bodies for `/offline`) now lives in
  // IndexedDB — purge the departing user's blob there, or it leaks to the next.
  // Kick it off WITHOUT awaiting first, so the synchronous Cache-API deletes
  // below still dispatch in the same tick (a caller may reload right after).
  const idbDone = idbRemoveItem(rqCacheKey(uid));
  await Promise.all([idbDone, clearWorkboxCaches()]);
  // Delete the localStorage keys AGAIN before resolving: the app is still
  // alive during the async deletions above, and an in-flight outbox send
  // settling (its finally → persist()) or a landing hydration save can
  // re-write the just-purged item-state/outbox keys mid-purge. The caller
  // reloads as soon as this resolves, so a final sweep here closes that
  // window and no departing user's triage writes survive on a shared device.
  try {
    window.localStorage.removeItem(rqCacheKey(uid));
    window.localStorage.removeItem(itemStateKey(uid));
    window.localStorage.removeItem(outboxKey(uid));
    window.localStorage.removeItem(COLLAPSED_FEEDS_KEY);
  } catch {
    // ignore (storage unavailable/denied)
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
    // The React-Query blob no longer lives in localStorage (it's in IndexedDB),
    // so there's nothing to move for it — only the item-state store migrates.
    // reclaimLegacyRqCache() below drops any stale localStorage RQ blob.
    moveKey(ITEM_STATE_BASE, itemStateKey(currentUid));
    window.localStorage.setItem(MIGRATED_KEY, '1');
  } catch {
    // ignore (storage unavailable/denied)
  }
}

// The persisted React-Query cache moved from localStorage to IndexedDB, so the
// old localStorage blob is dead weight (up to the full ~5 MB budget). Drop it on
// boot. We deliberately do NOT migrate it across: receiving a new app version
// requires being online, and `useOfflineCacheLock` re-warms every pinned/
// favorited item into IndexedDB on the next online open — so the cache
// repopulates itself, and the only window with an empty `/offline` is the rare
// case of an offline reload onto a service-worker-pre-cached update, which heals
// on the next online open. Idempotent and cheap.
function reclaimLegacyRqCache(currentUid: string | null): void {
  try {
    window.localStorage.removeItem(rqCacheKey(currentUid));
    window.localStorage.removeItem(RQ_CACHE_BASE);
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
  reclaimLegacyRqCache(currentUid);

  const marker = peekSignOutMarker();

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LAST_UID_KEY);
  } catch {
    // ignore (storage unavailable/denied)
  }

  // A SIGNED-OUT boot normally never purges, and leaves the sentinel alone.
  // The session may have been dropped by a failed token refresh (routine
  // while offline) rather than by a sign-out — so the previous user's scoped
  // stores must survive for their next sign-in (their /offline cache and pins
  // live there), and keeping the sentinel pointed at them means a DIFFERENT
  // user signing in later still purges them (guardrail #8).
  //
  // The exception is a boot that finds an ACTIVE sign-out marker: the reader
  // DID sign out, and either no purge has completed yet (pending — the tab
  // reloaded/closed before the in-tab handler ran or finished, Codex P2 on
  // #434) or one completed recently and late writes may have followed
  // (purged, within the grace). Purge, record the signed-out sentinel, and
  // stamp the completion only AFTER the purge resolves — a boot killed
  // mid-purge leaves the marker pending and the next one retries.
  if (currentUid === null) {
    if (marker === 'pending' || marker === 'purged') {
      const last = raw === null || raw === '' ? null : raw;
      if (last !== null) await clearUserCaches(last);
      try {
        window.localStorage.setItem(LAST_UID_KEY, '');
      } catch {
        // ignore (storage unavailable/denied)
      }
      markSignOutPurgeCompleted();
    } else if (marker === 'reauthed') {
      // A sign-in ended the episode for the uid-scoped stores; this
      // signed-out boot is the NEW session's routine drop (offline token
      // refresh). Keep the stores and the sentinel — only the shared Workbox
      // caches stay under the grace's sweep (Codex rounds 7-8).
      await clearWorkboxCaches();
    }
    return;
  }

  // First keyed boot (no sentinel): no previous user to purge.
  const last = raw === null ? currentUid : raw === '' ? null : raw;
  if (last !== currentUid) {
    await clearUserCaches(last);
  } else if (marker === 'pending') {
    // A PENDING sign-out marker for THIS user — its purge never completed.
    // Two ways here: a sign-out interrupted before its purge, followed by a
    // same-user reauth; or ANOTHER still-signed-in tab reloading in the
    // window between Sign out being tapped and Supabase emitting SIGNED_OUT
    // (the marker is localStorage, so every tab sees it — Codex P2 on #436,
    // round 2). Either way a pending marker purges the marked user — reading
    // it as stale here would let the signing-out tab's own old→null
    // transition be misread as a transient drop, leaving the departing
    // user's caches behind despite an explicit sign-out. The purge costs
    // only a re-warm.
    await clearUserCaches(currentUid);
  }
  try {
    window.localStorage.setItem(LAST_UID_KEY, currentUid);
  } catch {
    // ignore (storage unavailable/denied)
  }
  // Settle the marker for this SIGN-IN:
  //  - pending → stamp `purged` (its purge just ran above, via the mismatch
  //    or the same-uid branch). Stamped rather than cleared because this boot
  //    may not be the sign-out's owner (Codex P2 on #436, round 3): the
  //    signing-out tab can still write after our purge, and its own
  //    transition re-purges within the grace.
  //  - purged/reauthed → sweep the GLOBAL Workbox caches only and mark the
  //    episode `reauthed` (keeping the ORIGINAL stamp). The full purge
  //    already ran, and a full re-purge here would wipe the new session's
  //    uid-scoped stores on every reload within the grace (Codex round 6) —
  //    but the Workbox runtime caches are not uid-keyed yet, so a request
  //    from the departed user's dying tab settling AFTER the purge can
  //    repopulate `readmo-data` with their RLS-scoped response where the
  //    next user's service worker would serve it (Codex P1, round 7).
  //    Sweeping just those shared caches on every sign-in/reload until the
  //    grace ends closes that without touching the new session's own data,
  //    and the `reauthed` state tells the signed-out paths that a later
  //    session drop belongs to the NEW session — full-purging on it wiped the
  //    reauthenticated user's stores (Codex round 8).
  //  - absent/expired → sweep the leftover key.
  if (marker === 'pending') {
    markSignOutPurgeCompleted();
  } else if (marker === 'purged' || marker === 'reauthed') {
    await clearWorkboxCaches();
    markSignOutReauthed();
  } else {
    clearExplicitSignOut();
  }
}
