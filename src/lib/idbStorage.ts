// IndexedDB-backed key→value storage for the persisted React Query cache.
//
// Why IndexedDB and not localStorage: pinned/favorited article bodies are
// warmed into the persisted query cache so `/offline` can serve them with no
// network (SPEC.md *PWA & Offline → Offline reader cache*). localStorage caps
// at ~5 MB and is synchronous, so a handful of real article bodies overflow it
// and `setItem` throws QuotaExceededError — which the sync persister swallows,
// leaving NOTHING persisted. The user then reloads offline to an empty cache
// and `/offline` wrongly reads as "nothing saved". IndexedDB's quota is orders
// of magnitude larger (and async), so the bodies actually survive.
//
// This exposes the tiny `AsyncStorage` shape `createAsyncStoragePersister`
// wants (`getItem`/`setItem`/`removeItem` over string values) plus a direct
// `removeItem` used by the per-user cache purge (guardrail #8). Every operation
// degrades to a no-op/`null` when IndexedDB is unavailable (jsdom without a
// polyfill, SSR, privacy-mode denials), exactly like `localStoragePersistence`.

const DB_NAME = 'readmo-cache';
const STORE_NAME = 'keyval';

function hasIDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

// Cache the open request so we don't reopen the DB on every read/write. Reset to
// null on a failed open so a later call can retry rather than reusing a rejected
// promise forever.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise = dbPromise.catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

// Run one transaction against the keyval store and resolve with the request's
// result. Resolves on the transaction's `complete` event — NOT the request's
// `success` — so a readwrite (put/delete) is durably committed before we resolve:
// the request fires `success` before the transaction commits, and a caller that
// reloads the moment the purge resolves (useUserCacheScope on sign-out) could
// otherwise abort the still-uncommitted delete, leaking the blob into the next
// boot. Rejects if the DB can't be opened, the request errors, or the tx aborts.
function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = run(tx.objectStore(STORE_NAME));
        let result: T;
        req.onsuccess = () => {
          result = req.result as T;
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export async function getItem(key: string): Promise<string | null> {
  if (!hasIDB()) return null;
  try {
    const value = await withStore<unknown>('readonly', (store) => store.get(key));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  if (!hasIDB()) return;
  try {
    await withStore('readwrite', (store) => store.put(value, key));
  } catch {
    // Quota/denied — non-fatal, same as localStoragePersistence. The cache is
    // an optimization; a failed write just means a later read re-fetches.
  }
}

export async function removeItem(key: string): Promise<void> {
  if (!hasIDB()) return;
  try {
    await withStore('readwrite', (store) => store.delete(key));
  } catch {
    // ignore (unavailable/denied)
  }
}

/** The `AsyncStorage` object `createAsyncStoragePersister` consumes. */
export const idbStorage = { getItem, setItem, removeItem };

/**
 * Whether IndexedDB is actually usable for offline storage right now — not just
 * present, but openable and writable. Private/incognito sessions and
 * storage-blocked settings are the real cases where this is false (the API may be
 * defined but `open` throws or writes are denied), so we round-trip a throwaway
 * key rather than only checking `typeof indexedDB`. `/offline` uses this to tell
 * the user offline caching won't work instead of silently saving nothing.
 */
export async function isOfflineStorageAvailable(): Promise<boolean> {
  if (!hasIDB()) return false;
  const probeKey = '__readmo_probe__';
  await setItem(probeKey, '1'); // swallows failures → the read below reports them
  const ok = (await getItem(probeKey)) === '1';
  if (ok) await removeItem(probeKey);
  return ok;
}

/** Drop the cached DB handle. Tests use this to reset between cases. */
export function _resetIdbForTests(): void {
  dbPromise = null;
}
