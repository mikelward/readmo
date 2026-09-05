import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearExplicitSignOut,
  clearUserCaches,
  COLLAPSED_FEEDS_KEY,
  OPEN_MODE_SNAPSHOT_KEY,
  REVEALED_SPOILERS_KEY,
  itemStateKey,
  markExplicitSignOut,
  outboxKey,
  peekExplicitSignOut,
  reconcileUserCachesOnBoot,
  rqCacheKey,
} from './userCache';
import { getItem, setItem, _resetIdbForTests } from './idbStorage';
import {
  ackedSettingsKey,
  DIRTY_SETTINGS_KEY,
  SYNCED_SETTINGS_STORAGE_KEYS,
} from './settingsSync';

// fake-indexeddb keeps its data across `it` blocks; start each test with a fresh,
// empty IndexedDB so a blob seeded by one case can't leak into the next.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  _resetIdbForTests();
});

describe('cache key derivation', () => {
  it('keys by uid and falls back to the base key when signed out', () => {
    expect(rqCacheKey('u1')).toBe('readmo:rq-cache:u1');
    expect(rqCacheKey(null)).toBe('readmo:rq-cache');
    expect(itemStateKey('u1')).toBe('readmo:item-state:v2:u1');
    expect(itemStateKey(null)).toBe('readmo:item-state:v2');
    // The outbox key must match SupabaseDataSource's `${stateKey}:outbox`.
    expect(outboxKey('u1')).toBe('readmo:item-state:v2:u1:outbox');
    expect(outboxKey(null)).toBe('readmo:item-state:v2:outbox');
  });
});

describe('clearUserCaches', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("removes the user's keyed stores and deletes the named Workbox caches", async () => {
    window.localStorage.setItem(rqCacheKey('u1'), 'blob');
    window.localStorage.setItem(itemStateKey('u1'), 'state');
    window.localStorage.setItem(outboxKey('u1'), 'queued-writes');
    window.localStorage.setItem(rqCacheKey('u2'), 'keep'); // another user's data
    window.localStorage.setItem(outboxKey('u2'), 'keep'); // another user's outbox
    window.localStorage.setItem(COLLAPSED_FEEDS_KEY, '["feed-1"]'); // subscription-derived
    window.localStorage.setItem(REVEALED_SPOILERS_KEY, '["item-1"]'); // ditto
    window.localStorage.setItem(
      OPEN_MODE_SNAPSHOT_KEY,
      '{"openNewshacker":["feed-1"]}',
    ); // ditto

    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: del });

    await clearUserCaches('u1');

    expect(window.localStorage.getItem(rqCacheKey('u1'))).toBeNull();
    expect(window.localStorage.getItem(itemStateKey('u1'))).toBeNull();
    // The departing user's queued offline writes are purged too.
    expect(window.localStorage.getItem(outboxKey('u1'))).toBeNull();
    // The collapsed-feeds set is subscription-derived, so it must not survive an
    // account change on a shared device (guardrail #8). The revealed-spoilers
    // set names items one account subscribed to and chose to look at — same
    // rule, and it would tell the next reader which headlines the last one
    // peeked at.
    expect(window.localStorage.getItem(COLLAPSED_FEEDS_KEY)).toBeNull();
    expect(window.localStorage.getItem(REVEALED_SPOILERS_KEY)).toBeNull();
    expect(window.localStorage.getItem(OPEN_MODE_SNAPSHOT_KEY)).toBeNull();
    // A different user's persisted data is untouched.
    expect(window.localStorage.getItem(rqCacheKey('u2'))).toBe('keep');
    expect(window.localStorage.getItem(outboxKey('u2'))).toBe('keep');
    expect(del).toHaveBeenCalledWith('readmo-data');
    expect(del).toHaveBeenCalledWith('readmo-images');
    expect(del).toHaveBeenCalledWith('readmo-favicons');
  });

  it('purges the synced reading prefs and EVERY acked snapshot (account data, guardrail #8)', async () => {
    for (const key of SYNCED_SETTINGS_STORAGE_KEYS) {
      window.localStorage.setItem(key, '1');
    }
    window.localStorage.setItem(ackedSettingsKey('u1'), '{"groupByFeed":true}');
    window.localStorage.setItem(ackedSettingsKey('u2'), '{"groupByFeed":true}');
    window.localStorage.setItem(DIRTY_SETTINGS_KEY, '["groupByFeed"]');
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });

    await clearUserCaches('u1');

    // The synced prefs mirror the departing account's user_settings row, so
    // none may survive into the next account on a shared device.
    for (const key of SYNCED_SETTINGS_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key)).toBeNull();
    }
    expect(window.localStorage.getItem(ackedSettingsKey('u1'))).toBeNull();
    // EVERY account's snapshot goes with them — the pref keys are global, so a
    // leftover snapshot for a returning account would no longer match the
    // wiped prefs: a fresh flip to the stale-acked value would look already
    // delivered and a later reconcile would overwrite it (Codex P2 on #494).
    expect(window.localStorage.getItem(ackedSettingsKey('u2'))).toBeNull();
    // The dirty markers annotate the wiped prefs; left behind they'd push the
    // next account's defaults as if the user chose them.
    expect(window.localStorage.getItem(DIRTY_SETTINGS_KEY)).toBeNull();
  });

  it("purges the departing user's IndexedDB query-cache blob, not another user's", async () => {
    _resetIdbForTests();
    await setItem(rqCacheKey('u1'), 'u1-bodies');
    await setItem(rqCacheKey('u2'), 'u2-bodies');
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });

    await clearUserCaches('u1');

    expect(await getItem(rqCacheKey('u1'))).toBeNull();
    // A different user's cached bodies are untouched.
    expect(await getItem(rqCacheKey('u2'))).toBe('u2-bodies');
  });

  it('re-purges a key re-written during the async deletion window', async () => {
    // Regression (guardrail #8 residual data): the localStorage keys were
    // deleted once, up front — but the app is still alive during the async
    // IDB/Cache deletions, and an in-flight outbox send settling (its
    // finally → persist()) re-wrote the just-purged outbox key, so the
    // departing user's queued triage writes survived sign-out.
    window.localStorage.setItem(outboxKey('u1'), 'queued-writes');
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });

    const purge = clearUserCaches('u1');
    // The synchronous first sweep already ran; simulate the in-flight persist
    // landing while the async deletions are still pending.
    expect(window.localStorage.getItem(outboxKey('u1'))).toBeNull();
    window.localStorage.setItem(outboxKey('u1'), 'rewritten-mid-purge');

    await purge;
    expect(window.localStorage.getItem(outboxKey('u1'))).toBeNull();
  });

  it('no-ops without throwing when the Cache API is absent (jsdom/SSR)', async () => {
    vi.stubGlobal('caches', undefined);
    await expect(clearUserCaches('u1')).resolves.toBeUndefined();
  });

  it('swallows localStorage failures', async () => {
    vi.stubGlobal('caches', undefined);
    const spy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => {
        throw new Error('storage denied');
      });
    await expect(clearUserCaches('u1')).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('reconcileUserCachesOnBoot', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('purges the previous user when booting under a different uid', async () => {
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(rqCacheKey('old'), 'blob');
    window.localStorage.setItem(itemStateKey('old'), 'state');

    await reconcileUserCachesOnBoot('new');

    expect(window.localStorage.getItem(rqCacheKey('old'))).toBeNull();
    expect(window.localStorage.getItem(itemStateKey('old'))).toBeNull();
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');
    // Records the new boot uid for next time.
    expect(window.localStorage.getItem('readmo:last-uid')).toBe('new');
  });

  it('does not purge when booting under the same uid', async () => {
    window.localStorage.setItem('readmo:last-uid', 'same');
    // Item-state is the per-user data persisted in localStorage now (the
    // React-Query blob moved to IndexedDB); it must survive a same-uid boot.
    window.localStorage.setItem(itemStateKey('same'), 'keep');

    await reconcileUserCachesOnBoot('same');

    expect(window.localStorage.getItem(itemStateKey('same'))).toBe('keep');
    expect(caches.delete).not.toHaveBeenCalled();
  });

  it('reclaims a stale localStorage query-cache blob left by a pre-IndexedDB build', async () => {
    // The React-Query cache lives in IndexedDB now and re-warms on the next
    // online open, so the dead localStorage blob is simply dropped (not migrated):
    // it would otherwise crowd out the ~5 MB budget the item-state store needs.
    window.localStorage.setItem('readmo:last-uid', 'demo');
    window.localStorage.setItem(rqCacheKey('demo'), 'stale-bodies');

    await reconcileUserCachesOnBoot('demo');

    expect(window.localStorage.getItem(rqCacheKey('demo'))).toBeNull();
  });

  it('a signed-out boot never purges and keeps the sentinel on the prior user', async () => {
    // The session can drop on its own — supabase-js clears it when a token
    // refresh fails, which happens routinely OFFLINE. A signed-out boot must
    // not treat that as a departure: the prior user's stores survive for
    // their next sign-in (their /offline cache lives there), and the sentinel
    // keeps pointing at them so a DIFFERENT user signing in later still
    // purges (guardrail #8). An explicit sign-out purges in-tab instead.
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(itemStateKey('old'), 'pins-and-favorites');

    await reconcileUserCachesOnBoot(null);

    expect(window.localStorage.getItem(itemStateKey('old'))).toBe(
      'pins-and-favorites',
    );
    expect(caches.delete).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('readmo:last-uid')).toBe('old');
  });

  it('the same user signing back in after a transient session drop keeps their caches', async () => {
    // Follow-on from the signed-out boot above: the user re-authenticates.
    // Sentinel still points at them → same-uid boot → no purge.
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(itemStateKey('old'), 'pins-and-favorites');

    await reconcileUserCachesOnBoot(null); // transient signed-out boot
    await reconcileUserCachesOnBoot('old'); // signs back in

    expect(window.localStorage.getItem(itemStateKey('old'))).toBe(
      'pins-and-favorites',
    );
    expect(caches.delete).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('readmo:last-uid')).toBe('old');
  });

  it('a different user signing in after a transient drop still purges the prior user', async () => {
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(itemStateKey('old'), 'private');

    await reconcileUserCachesOnBoot(null); // transient signed-out boot
    await reconcileUserCachesOnBoot('new'); // someone else signs in

    expect(window.localStorage.getItem(itemStateKey('old'))).toBeNull();
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');
    expect(window.localStorage.getItem('readmo:last-uid')).toBe('new');
  });

  it('finishes an explicit sign-out whose in-tab purge never ran (marker survives to boot)', async () => {
    // Codex P2 on #434: the reader taps Sign out, but the tab reloads/closes
    // before useUserCacheScope observes the transition. The marker (in
    // localStorage, so it survives the tab) must make the next boot finish
    // the purge and record the signed-out sentinel — an explicit sign-out
    // may never leave the departing user's data behind (guardrail #8).
    markExplicitSignOut();
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(itemStateKey('old'), 'private');

    await reconcileUserCachesOnBoot(null);

    expect(window.localStorage.getItem(itemStateKey('old'))).toBeNull();
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');
    expect(window.localStorage.getItem('readmo:last-uid')).toBe('');
    // The marker moves pending → purged (never hard-cleared while active):
    // still active through the grace so any tab's late writes get re-purged,
    // then it expires and a later transient drop can't be misread.
    expect(
      window.localStorage.getItem('readmo:explicit-signout'),
    ).toMatch(/^d:/);
  });

  it('a PENDING marker never expires — the purge is owed however late the next boot is', async () => {
    // Codex P2 on #436, round 4: sign out, tab dies before ANY purge runs,
    // device reopened days later. The pending marker must still be honored —
    // expiring it would leave private data behind despite an explicit
    // sign-out. (Only the purged state expires; see below.)
    window.localStorage.setItem(
      'readmo:explicit-signout',
      `p:${Date.now() - 3 * 24 * 60 * 60 * 1000}`,
    );
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(itemStateKey('old'), 'private');

    await reconcileUserCachesOnBoot(null);

    expect(window.localStorage.getItem(itemStateKey('old'))).toBeNull();
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');
  });

  it('a same-uid signed-in boot with a pending marker purges but LEAVES the marker (cross-tab race)', async () => {
    // Codex P2 on #436, rounds 2-3: the marker is localStorage, so a SECOND
    // still-signed-in tab reloading between Sign out being tapped and
    // Supabase emitting SIGNED_OUT boots as the SAME uid. That boot must
    // purge (reading the marker as stale would let the original tab's
    // old→null transition be misread as a transient drop) — but it is NOT
    // the auth-transition owner: the signing-out tab may still re-write keys
    // after this purge, so the marker stays pending for that tab's own
    // transition (or the next boot) to re-purge and settle.
    markExplicitSignOut();
    window.localStorage.setItem('readmo:last-uid', 'same');
    window.localStorage.setItem(itemStateKey('same'), 'private');

    await reconcileUserCachesOnBoot('same');

    expect(window.localStorage.getItem(itemStateKey('same'))).toBeNull();
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');
    expect(peekExplicitSignOut()).toBe(true); // still active for the owner

    // The signing-out side's own path — here, the next signed-out boot —
    // re-purges (idempotent, covers late writes) and re-stamps; the marker
    // then dies by grace expiry, not by any tab clearing it.
    await reconcileUserCachesOnBoot(null);
    expect(
      window.localStorage.getItem('readmo:explicit-signout'),
    ).toMatch(/^d:/);
    expect(window.localStorage.getItem('readmo:last-uid')).toBe('');
  });

  it('an expired PURGED marker reads as absent — a later session drop stays transient', async () => {
    // A purged marker means the sign-out's purge already completed; it stays
    // active only through a short grace (for the owner tab's late writes).
    // Past that it must read as absent: treating it as a live sign-out would
    // turn a token-refresh drop days later — routine offline — into a
    // spurious cache wipe (the #434 bug). A signed-in boot sweeps it.
    window.localStorage.setItem(
      'readmo:explicit-signout',
      `d:${Date.now() - 11 * 60 * 1000}`,
    );
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(itemStateKey('old'), 'pins-and-favorites');

    expect(peekExplicitSignOut()).toBe(false);
    await reconcileUserCachesOnBoot(null); // treated as a transient drop
    expect(window.localStorage.getItem(itemStateKey('old'))).toBe(
      'pins-and-favorites',
    );
    expect(caches.delete).not.toHaveBeenCalled();

    await reconcileUserCachesOnBoot('old'); // same-user boot sweeps the leftover
    expect(window.localStorage.getItem('readmo:explicit-signout')).toBeNull();
  });

  it('reloads after a reauth keep the new session; only the shared Workbox caches sweep during the grace', async () => {
    // Codex P2 round 6 + P1 round 7 on #436, together: after a completed
    // sign-out (marker `purged`), a reauth within the grace must NOT wipe the
    // new session's uid-scoped stores on every reload (round 6's restamp
    // loop) — but the marker must survive the sign-in, because the GLOBAL
    // Workbox caches can be repopulated by the departed session's in-flight
    // requests settling after the purge, and only the graced marker keeps
    // sweeping them (round 7).
    markExplicitSignOut();
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(itemStateKey('old'), 'pre-signout');
    await reconcileUserCachesOnBoot(null); // sign-out completes: purge + 'd:'
    const stamped = window.localStorage.getItem('readmo:explicit-signout');
    expect(stamped).toMatch(/^d:/);

    // Reauth within the grace: the marker survives, marked `reauthed`, on its
    // ORIGINAL timestamp (no refresh — the grace stays anchored to the
    // sign-out).
    await reconcileUserCachesOnBoot('old');
    expect(window.localStorage.getItem('readmo:explicit-signout')).toBe(
      `r:${stamped!.slice(2)}`,
    );

    // The new session accumulates uid-scoped caches; a reload within the
    // grace keeps them and sweeps ONLY the shared Workbox caches.
    window.localStorage.setItem(itemStateKey('old'), 'fresh-session');
    (caches.delete as ReturnType<typeof vi.fn>).mockClear();
    await reconcileUserCachesOnBoot('old');
    expect(window.localStorage.getItem(itemStateKey('old'))).toBe(
      'fresh-session',
    );
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');

    // Past the grace the marker reads as absent and the next sign-in boot
    // sweeps the leftover key; reloads stop touching the Workbox caches.
    window.localStorage.setItem(
      'readmo:explicit-signout',
      `d:${Date.now() - 11 * 60 * 1000}`,
    );
    (caches.delete as ReturnType<typeof vi.fn>).mockClear();
    await reconcileUserCachesOnBoot('old');
    expect(window.localStorage.getItem('readmo:explicit-signout')).toBeNull();
    expect(caches.delete).not.toHaveBeenCalled();
  });

  it('a session drop after a reauth keeps the new session (reauthed marker never full-purges)', async () => {
    // Codex P2 on #436, round 8: sign-out completes (marker purged), the
    // reader signs back in within the grace, then Supabase drops the session
    // on a routine offline token-refresh failure. That drop belongs to the
    // NEW session — treating the leftover marker as a live sign-out wiped the
    // reauthenticated user's pins/offline stores. Only the shared Workbox
    // caches may keep sweeping.
    markExplicitSignOut();
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(itemStateKey('old'), 'pre-signout');
    await reconcileUserCachesOnBoot(null); // sign-out completes: purge + 'd:'
    await reconcileUserCachesOnBoot('old'); // reauth: marker → 'r:'

    // The new session accumulates data; then the transient drop hits.
    window.localStorage.setItem(itemStateKey('old'), 'fresh-session');
    (caches.delete as ReturnType<typeof vi.fn>).mockClear();
    await reconcileUserCachesOnBoot(null);

    expect(window.localStorage.getItem(itemStateKey('old'))).toBe(
      'fresh-session',
    );
    // Sentinel still points at the user, so signing back in purges nothing.
    expect(window.localStorage.getItem('readmo:last-uid')).toBe('old');
    // The shared Workbox caches were swept (the only grace action left).
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');

    await reconcileUserCachesOnBoot('old');
    expect(window.localStorage.getItem(itemStateKey('old'))).toBe(
      'fresh-session',
    );
  });

  it('a marker pending across an account switch is satisfied by the uid-mismatch purge', async () => {
    // A sign-out (marker set, purge never ran) followed by a DIFFERENT user
    // signing in: the mismatch purge clears the departed user and stamps the
    // marker purged; the new user's fresh scope is untouched.
    markExplicitSignOut();
    window.localStorage.setItem('readmo:last-uid', 'old');
    window.localStorage.setItem(itemStateKey('old'), 'private');
    window.localStorage.setItem(itemStateKey('new'), 'mine');

    await reconcileUserCachesOnBoot('new');

    expect(window.localStorage.getItem(itemStateKey('old'))).toBeNull();
    expect(window.localStorage.getItem(itemStateKey('new'))).toBe('mine');
    expect(
      window.localStorage.getItem('readmo:explicit-signout'),
    ).toMatch(/^d:/);
  });

  it('peeking the sign-out marker does not consume it (a killed purge can retry on the next boot)', () => {
    // Codex P2 on #436: the marker must survive being READ at purge start —
    // it's dropped only after the purge resolves, so a tab killed mid-purge
    // (async IndexedDB/Cache API deletes) leaves it for the next boot.
    markExplicitSignOut();
    expect(peekExplicitSignOut()).toBe(true);
    expect(peekExplicitSignOut()).toBe(true); // read-only — still pending
    clearExplicitSignOut();
    expect(peekExplicitSignOut()).toBe(false);
  });

  it('migrates the legacy item-state store into the user scope on first keyed boot', async () => {
    // No sentinel / no migrated flag → an install upgrading to the keyed layout.
    window.localStorage.setItem(itemStateKey(null), 'legacy-state');
    // Writes queued offline on the pre-scoping build (same v2 entry shape).
    window.localStorage.setItem(outboxKey(null), 'legacy-outbox');
    // A legacy localStorage React-Query blob from before the IndexedDB move.
    window.localStorage.setItem(rqCacheKey(null), 'legacy-rq');

    await reconcileUserCachesOnBoot('demo');

    // Item-state is moved into the demo user's scope, not wiped.
    expect(window.localStorage.getItem(itemStateKey('demo'))).toBe('legacy-state');
    expect(window.localStorage.getItem(itemStateKey(null))).toBeNull();
    // The queued offline writes move with it — orphaned at the unscoped key
    // they were never replayed (and never purged), silently dropping the user
    // triage the outbox exists to make durable.
    expect(window.localStorage.getItem(outboxKey('demo'))).toBe('legacy-outbox');
    expect(window.localStorage.getItem(outboxKey(null))).toBeNull();
    // The React-Query blob now lives in IndexedDB, so the localStorage copy is
    // dropped rather than carried into the user's scope.
    expect(window.localStorage.getItem(rqCacheKey('demo'))).toBeNull();
    expect(window.localStorage.getItem(rqCacheKey(null))).toBeNull();
    // First keyed boot has no previous user, so nothing is purged.
    expect(caches.delete).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('readmo:last-uid')).toBe('demo');
  });

  it('migrates only once (subsequent boots leave the base keys alone)', async () => {
    window.localStorage.setItem('readmo:cache-migrated', '1');
    window.localStorage.setItem(itemStateKey(null), 'anon-scratch');

    await reconcileUserCachesOnBoot('demo');

    // Already migrated → the base key is not pulled into the user's scope.
    expect(window.localStorage.getItem(itemStateKey('demo'))).toBeNull();
    expect(window.localStorage.getItem(itemStateKey(null))).toBe('anon-scratch');
  });
});
