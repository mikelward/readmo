import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadApp } from './reload';
import {
  CHUNK_RELOAD_GUARD_KEY,
  ENTRY_RELOAD_GUARD_KEY,
  clearChunkReloadGuard,
  clearEntryReloadGuard,
  installGlobalChunkReloadGuard,
  isChunkLoadError,
  reloadOnceForChunkError,
} from './chunkReload';

// Mock the reload seam (jsdom's window.location is non-configurable, so the
// codebase routes reloads through this module precisely so tests can stub it).
vi.mock('./reload', () => ({ reloadApp: vi.fn() }));
const reload = vi.mocked(reloadApp);

describe('isChunkLoadError', () => {
  it('matches the deploy/network chunk-load failure family', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: /assets/FeedsPage-abc.js',
      'error loading dynamically imported module',
      'Loading chunk 5 failed',
      'importing a module script failed',
      "Expected a JavaScript module script but the server responded with a MIME type of text/html",
      'ChunkLoadError: something',
    ]) {
      expect(isChunkLoadError(new Error(message))).toBe(true);
      // Also accepts a bare string (window `error` event message).
      expect(isChunkLoadError(message)).toBe(true);
    }
  });

  it('does not match unrelated errors or non-error values', () => {
    expect(isChunkLoadError(new Error('some render bug'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({ message: 'loading chunk failed' })).toBe(false);
  });
});

describe('reloadOnceForChunkError', () => {
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('reloads once and records the one-shot guard', () => {
    expect(reloadOnceForChunkError()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBe('1');
  });

  it('does not reload a second time within the same budget', () => {
    sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
    expect(reloadOnceForChunkError()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again after the guard is cleared (per-deploy budget)', () => {
    reloadOnceForChunkError();
    clearChunkReloadGuard();
    expect(sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBeNull();
    expect(reloadOnceForChunkError()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('fails closed when storage is blocked (no reload, avoids a loop)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is disabled');
    });
    expect(reloadOnceForChunkError()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('entry vs chunk budgets are independent', () => {
  beforeEach(() => sessionStorage.clear());

  it('uses distinct session keys', () => {
    expect(ENTRY_RELOAD_GUARD_KEY).not.toBe(CHUNK_RELOAD_GUARD_KEY);
  });

  it('clearEntryReloadGuard leaves the chunk budget untouched', () => {
    // The lazy-loop fix: a successful boot clears the entry budget but must not
    // hand LazyRouteBoundary a fresh chunk budget (which would loop the reload
    // for a still-failing lazy chunk).
    sessionStorage.setItem(ENTRY_RELOAD_GUARD_KEY, '1');
    sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
    clearEntryReloadGuard();
    expect(sessionStorage.getItem(ENTRY_RELOAD_GUARD_KEY)).toBeNull();
    expect(sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBe('1');
  });

  it('clearChunkReloadGuard leaves the entry budget untouched', () => {
    sessionStorage.setItem(ENTRY_RELOAD_GUARD_KEY, '1');
    sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
    clearChunkReloadGuard();
    expect(sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBeNull();
    expect(sessionStorage.getItem(ENTRY_RELOAD_GUARD_KEY)).toBe('1');
  });

  it('clearEntryReloadGuard does not throw when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is disabled');
    });
    expect(() => clearEntryReloadGuard()).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe('installGlobalChunkReloadGuard', () => {
  let dispose: () => void;

  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
    dispose = installGlobalChunkReloadGuard();
  });
  afterEach(() => {
    dispose();
    vi.restoreAllMocks();
  });

  it('reloads on a vite:preloadError', () => {
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads on an uncaught chunk-load rejection', () => {
    const event = new Event('unhandledrejection');
    Object.assign(event, {
      reason: new Error(
        'Failed to fetch dynamically imported module: /assets/x.js',
      ),
    });
    window.dispatchEvent(event);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores an unrelated rejection', () => {
    const event = new Event('unhandledrejection');
    Object.assign(event, { reason: new Error('network is offline') });
    window.dispatchEvent(event);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when a hashed /assets/ script fails to load', () => {
    const script = document.createElement('script');
    script.src = 'https://readmo.app/assets/index-oldhash.js';
    document.body.appendChild(script);
    script.dispatchEvent(new Event('error'));
    expect(reload).toHaveBeenCalledTimes(1);
    script.remove();
  });

  it('ignores a resource error from outside /assets/', () => {
    const img = document.createElement('img');
    img.src = 'https://readmo.app/api/img?url=x';
    document.body.appendChild(img);
    img.dispatchEvent(new Event('error'));
    expect(reload).not.toHaveBeenCalled();
    img.remove();
  });

  it('removes its listeners when disposed', () => {
    dispose();
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(reload).not.toHaveBeenCalled();
    // Re-install so afterEach's dispose() is a no-op-safe double call.
    dispose = installGlobalChunkReloadGuard();
  });
});
