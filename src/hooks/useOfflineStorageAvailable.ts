import { useEffect, useState } from 'react';
import { isOfflineStorageAvailable } from '../lib/idbStorage';

/**
 * Probe once whether IndexedDB is usable for the persisted offline cache.
 * Returns `undefined` while the (async) probe runs, then `true`/`false`. Consumers
 * should treat `undefined` as "assume available" so the unavailable message never
 * flashes before the probe settles. IndexedDB availability is fixed for the life
 * of a session (a private-mode tab stays private), so a single probe suffices.
 */
export function useOfflineStorageAvailable(): boolean | undefined {
  const [available, setAvailable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void isOfflineStorageAvailable().then((value) => {
      if (!cancelled) setAvailable(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}
