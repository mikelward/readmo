import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getItem,
  setItem,
  removeItem,
  isOfflineStorageAvailable,
  _resetIdbForTests,
} from './idbStorage';

describe('idbStorage', () => {
  beforeEach(() => {
    // Fresh, empty IndexedDB per test so values don't leak between cases.
    globalThis.indexedDB = new IDBFactory();
    _resetIdbForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetIdbForTests();
  });

  it('round-trips a value through IndexedDB', async () => {
    await setItem('k', 'hello');
    expect(await getItem('k')).toBe('hello');
  });

  it('returns null for a missing key', async () => {
    expect(await getItem('absent')).toBeNull();
  });

  it('overwrites an existing value', async () => {
    await setItem('k', 'first');
    await setItem('k', 'second');
    expect(await getItem('k')).toBe('second');
  });

  it('removes a value', async () => {
    await setItem('k', 'gone-soon');
    await removeItem('k');
    expect(await getItem('k')).toBeNull();
  });

  it('keeps keys independent', async () => {
    await setItem('a', '1');
    await setItem('b', '2');
    await removeItem('a');
    expect(await getItem('a')).toBeNull();
    expect(await getItem('b')).toBe('2');
  });

  it('stores values large enough to overflow localStorage', async () => {
    // The whole point of moving off localStorage: a multi-MB blob (real article
    // bodies) that would blow the ~5 MB synchronous cap persists fine here.
    const big = 'x'.repeat(8 * 1024 * 1024);
    await setItem('big', big);
    expect((await getItem('big'))?.length).toBe(big.length);
  });

  it('degrades to a no-op when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    _resetIdbForTests();
    await expect(setItem('k', 'v')).resolves.toBeUndefined();
    await expect(getItem('k')).resolves.toBeNull();
    await expect(removeItem('k')).resolves.toBeUndefined();
  });

  it('reports storage available when IndexedDB round-trips, and leaves no probe key', async () => {
    expect(await isOfflineStorageAvailable()).toBe(true);
    // The throwaway probe key is cleaned up.
    expect(await getItem('__readmo_probe__')).toBeNull();
  });

  it('reports storage unavailable when IndexedDB is absent', async () => {
    vi.stubGlobal('indexedDB', undefined);
    _resetIdbForTests();
    expect(await isOfflineStorageAvailable()).toBe(false);
  });
});
