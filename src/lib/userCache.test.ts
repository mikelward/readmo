import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUserCaches, itemStateKey, rqCacheKey } from './userCache';

describe('cache key derivation', () => {
  it('keys by uid and falls back to the base key when signed out', () => {
    expect(rqCacheKey('u1')).toBe('readmo:rq-cache:u1');
    expect(rqCacheKey(null)).toBe('readmo:rq-cache');
    expect(itemStateKey('u1')).toBe('readmo:item-state:u1');
    expect(itemStateKey(null)).toBe('readmo:item-state');
  });
});

describe('clearUserCaches', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("removes the user's keyed stores and deletes the named Workbox caches", async () => {
    window.localStorage.setItem(rqCacheKey('u1'), 'blob');
    window.localStorage.setItem(itemStateKey('u1'), 'state');
    window.localStorage.setItem(rqCacheKey('u2'), 'keep'); // another user's data

    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: del });

    await clearUserCaches('u1');

    expect(window.localStorage.getItem(rqCacheKey('u1'))).toBeNull();
    expect(window.localStorage.getItem(itemStateKey('u1'))).toBeNull();
    // A different user's persisted data is untouched.
    expect(window.localStorage.getItem(rqCacheKey('u2'))).toBe('keep');
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
