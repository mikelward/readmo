import { useEffect } from 'react';
import { useDataSource } from '../lib/data/context';
import {
  createSettingsSyncEngine,
  READING_PREF_CHANGE_EVENT,
} from '../lib/settingsSync';
import { useAuth } from './useAuth';

/** How long after the last pref flip the push fires, so a burst of toggling in
 * Settings coalesces into one write instead of a request per tap. */
export const SETTINGS_PUSH_DEBOUNCE_MS = 400;

/**
 * Keep the account's synced reading-behavior settings reconciled with the
 * server (SPEC.md *Settings* → scope): hydrate on sign-in/boot, re-pull on
 * focus/online (so a change made on another device shows up here, like
 * useStateSync does for item state), and push local pref changes as they
 * happen. Mounted once at the App level.
 *
 * A no-op while signed out and for sources without the settings transport
 * (the mock — demo mode has no account, so prefs stay device-local; an old
 * backend is handled inside SupabaseDataSource the same way).
 */
export function useSettingsSync(): void {
  const ds = useDataSource();
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  useEffect(() => {
    const get = ds.getSyncedSettings?.bind(ds);
    const set = ds.setSyncedSettings?.bind(ds);
    if (!uid || !get || !set) return;
    const engine = createSettingsSyncEngine(uid, { get, set });

    // Engine failures are transient by construction (a failed push keeps its
    // diff pending; a failed fetch applies nothing) and every trigger below
    // re-runs, so swallow rather than surface an unhandled rejection.
    const reconcile = () => {
      // A bare `focus` can fire on a still-hidden tab in some browsers; only
      // sync when the page is actually visible (same guard as useStateSync).
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      void engine.reconcile().catch(() => {});
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconcile();
    };

    let pushTimer: ReturnType<typeof setTimeout> | undefined;
    const schedulePush = () => {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        void engine.push().catch(() => {});
      }, SETTINGS_PUSH_DEBOUNCE_MS);
    };

    // Boot hydration. The engine never overwrites a pref changed locally but
    // not yet acknowledged by the server, so this is safe to run any time.
    void engine.reconcile().catch(() => {});

    // Local changes (this tab via the pref change event, another tab via
    // `storage`) schedule a push; the engine diffs against the shared acked
    // snapshot, so an event with nothing new to send — including the engine's
    // own hydration writes — pushes nothing.
    window.addEventListener(READING_PREF_CHANGE_EVENT, schedulePush);
    window.addEventListener('storage', schedulePush);
    window.addEventListener('focus', reconcile);
    window.addEventListener('online', reconcile);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      // Cancel, don't just unlisten: an in-flight reconcile/push started under
      // this uid must not apply or ack anything once the effect is torn down —
      // on an auth transition it would write the departing account's values
      // back into pref keys clearUserCaches just purged (guardrail #8), or
      // push them under the next session (see SettingsSyncEngine.cancel).
      engine.cancel();
      clearTimeout(pushTimer);
      window.removeEventListener(READING_PREF_CHANGE_EVENT, schedulePush);
      window.removeEventListener('storage', schedulePush);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('online', reconcile);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [uid, ds]);
}
