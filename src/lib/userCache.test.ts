import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearUserCaches,
  COLLAPSED_FEEDS_KEY,
  itemStateKey,
  outboxKey,
  reconcileUserCachesOnBoot,
  rqCacheKey,
} from './userCache';
import { getItem, setItem, _resetIdbForTests } from './idbStorage';

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

    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: del });

    await clearUserCaches('u1');

    expect(window.localStorage.getItem(rqCacheKey('u1'))).toBeNull();
    expect(window.localStorage.getItem(itemStateKey('u1'))).toBeNull();
    // The departing user's queued offline writes are purged too.
    expect(window.localStorage.getItem(outboxKey('u1'))).toBeNull();
    // The collapsed-feeds set is subscription-derived, so it must not survive an
    // account change on a shared device (guardrail #8).
    expect(window.localStorage.getItem(COLLAPSED_FEEDS_KEY)).toBeNull();
    // A different user's persisted data is untouched.
    expect(window.localStorage.getItem(rqCacheKey('u2'))).toBe('keep');
    expect(window.localStorage.getItem(outboxKey('u2'))).toBe('keep');
    expect(del).toHaveBeenCalledWith('readmo-data');
    expect(del).toHaveBeenCalledWith('readmo-images');
    expect(del).toHaveBeenCalledWith('readmo-favicons');
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

  it('migrates the legacy item-state store into the user scope on first keyed boot', async () => {
    // No sentinel / no migrated flag → an install upgrading to the keyed layout.
    window.localStorage.setItem(itemStateKey(null), 'legacy-state');
    // A legacy localStorage React-Query blob from before the IndexedDB move.
    window.localStorage.setItem(rqCacheKey(null), 'legacy-rq');

    await reconcileUserCachesOnBoot('demo');

    // Item-state is moved into the demo user's scope, not wiped.
    expect(window.localStorage.getItem(itemStateKey('demo'))).toBe('legacy-state');
    expect(window.localStorage.getItem(itemStateKey(null))).toBeNull();
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
