import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearUserCaches,
  COLLAPSED_FEEDS_KEY,
  itemStateKey,
  outboxKey,
  reconcileUserCachesOnBoot,
  rqCacheKey,
} from './userCache';

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
    window.localStorage.setItem(rqCacheKey('same'), 'keep');

    await reconcileUserCachesOnBoot('same');

    expect(window.localStorage.getItem(rqCacheKey('same'))).toBe('keep');
    expect(caches.delete).not.toHaveBeenCalled();
  });

  it('records the signed-out sentinel and purges the prior user', async () => {
    window.localStorage.setItem('readmo:last-uid', 'old');
    await reconcileUserCachesOnBoot(null);
    // Sentinel is recorded as '' (present) to distinguish signed-out from a
    // never-booted (first-run) install.
    expect(window.localStorage.getItem('readmo:last-uid')).toBe('');
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');
  });

  it('migrates legacy global stores into the user scope on first keyed boot', async () => {
    // No sentinel / no migrated flag → an install upgrading to the keyed layout.
    window.localStorage.setItem(itemStateKey(null), 'legacy-state');
    window.localStorage.setItem(rqCacheKey(null), 'legacy-rq');

    await reconcileUserCachesOnBoot('demo');

    // Legacy data is moved into the demo user's scope, not wiped.
    expect(window.localStorage.getItem(itemStateKey('demo'))).toBe('legacy-state');
    expect(window.localStorage.getItem(rqCacheKey('demo'))).toBe('legacy-rq');
    expect(window.localStorage.getItem(itemStateKey(null))).toBeNull();
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
