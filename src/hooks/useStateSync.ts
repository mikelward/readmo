import { useEffect } from 'react';
import { useDataSource } from '../lib/data/context';

/**
 * Re-pull item state from the server whenever the tab regains focus or
 * visibility, or the device comes back online, so a pin / favorite / done made
 * on *another device* shows up here without a manual pull-to-refresh. This is
 * the "refetch-on-focus" half of the MVP sync story (SPEC.md *Sync*): boot
 * hydration is memoized and never re-runs on its own, so a backgrounded tab
 * would otherwise keep showing the pins it loaded at boot.
 *
 * Mounted once at the App level (like `useFeedInvalidation`) so it runs
 * app-wide regardless of the current route. `resyncState` coalesces overlapping
 * calls — a single tab return can fire both `focus` and `visibilitychange` —
 * and the mock no-ops it, so wiring it broadly is cheap.
 */
export function useStateSync() {
  const ds = useDataSource();

  useEffect(() => {
    const resync = () => {
      // A bare `focus` can fire on a still-hidden tab in some browsers; only
      // sync when the page is actually visible, so we don't re-pull for a
      // window that just gained focus while occluded.
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      // A transient/offline re-pull failure self-heals (ensureHydrated clears
      // its memo so the next read retries); swallow it here so it isn't an
      // unhandled rejection.
      void ds.resyncState().catch(() => {});
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') resync();
    };

    window.addEventListener('focus', resync);
    window.addEventListener('online', resync);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', resync);
      window.removeEventListener('online', resync);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [ds]);
}
