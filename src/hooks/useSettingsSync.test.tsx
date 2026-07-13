import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { DataSourceProvider } from '../lib/data/context';
import type { DataSource } from '../lib/data/DataSource';
import {
  ackedSettingsKey,
  ITEM_SORT_KEY,
  GROUP_BY_FEED_KEY,
  READING_PREF_CHANGE_EVENT,
  type SyncedSettings,
} from '../lib/settingsSync';
import { useSettingsSync, SETTINGS_PUSH_DEBOUNCE_MS } from './useSettingsSync';

// The mock auth path (no Supabase configured under vitest) reports the demo
// user as signed in when this key is set — see useAuth.
const MOCK_SIGNED_IN_KEY = 'readmo:mock-signed-in';
const DEMO_UID = 'mock:demo@readmo.app';

function makeSource(server: Partial<SyncedSettings> | null = {}) {
  const getSyncedSettings = vi.fn(async () => server);
  const setSyncedSettings = vi.fn(async (_patch: Partial<SyncedSettings>) => {});
  const source = { getSyncedSettings, setSyncedSettings };
  return { source: source as unknown as DataSource, getSyncedSettings, setSyncedSettings };
}

function Host() {
  useSettingsSync();
  return null;
}

function mount(source: DataSource) {
  return render(
    <DataSourceProvider source={source}>
      <Host />
    </DataSourceProvider>,
  );
}

/** Let the engine's in-flight promise chain settle under fake timers. */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useSettingsSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.localStorage.setItem(MOCK_SIGNED_IN_KEY, '1');
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('hydrates server values on mount without echoing a push back', async () => {
    const { source, getSyncedSettings, setSyncedSettings } = makeSource({
      itemSort: 'oldest',
    });
    mount(source);
    await flush();

    expect(getSyncedSettings).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBe('oldest');

    // The hydration write fired the pref change event, which schedules a push —
    // but the applied value is acked, so the diff is empty and nothing is sent.
    await flush(SETTINGS_PUSH_DEBOUNCE_MS + 50);
    expect(setSyncedSettings).not.toHaveBeenCalled();
  });

  it('pushes a local pref change after the debounce, coalescing a burst into one write', async () => {
    const { source, setSyncedSettings } = makeSource({});
    mount(source);
    await flush();

    // A settings-page burst: two flips within the debounce window (what a
    // store.set does — write the key, dispatch the shared change event).
    window.localStorage.setItem(ITEM_SORT_KEY, 'oldest');
    window.dispatchEvent(new Event(READING_PREF_CHANGE_EVENT));
    await flush(SETTINGS_PUSH_DEBOUNCE_MS / 2);
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '1');
    window.dispatchEvent(new Event(READING_PREF_CHANGE_EVENT));
    await flush(SETTINGS_PUSH_DEBOUNCE_MS + 50);

    expect(setSyncedSettings).toHaveBeenCalledTimes(1);
    expect(setSyncedSettings).toHaveBeenCalledWith({
      itemSort: 'oldest',
      groupByFeed: true,
    });
    // Acked under the signed-in uid, so nothing re-pushes later.
    expect(
      window.localStorage.getItem(ackedSettingsKey(DEMO_UID)),
    ).toContain('"itemSort":"oldest"');
  });

  it('re-reconciles when the device comes back online', async () => {
    const { source, getSyncedSettings } = makeSource({});
    mount(source);
    await flush();
    expect(getSyncedSettings).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await flush();
    expect(getSyncedSettings).toHaveBeenCalledTimes(2);
  });

  it('does nothing while signed out', async () => {
    window.localStorage.removeItem(MOCK_SIGNED_IN_KEY);
    const { source, getSyncedSettings } = makeSource({});
    mount(source);
    await flush();
    expect(getSyncedSettings).not.toHaveBeenCalled();
  });

  it('does nothing for a source without the settings transport (the mock)', async () => {
    const source = {} as unknown as DataSource;
    mount(source); // must not crash
    await flush();
    window.dispatchEvent(new Event(READING_PREF_CHANGE_EVENT));
    await flush(SETTINGS_PUSH_DEBOUNCE_MS + 50);
  });

  it('cancels an in-flight hydration on unmount so a late result cannot write (guardrail #8)', async () => {
    // The auth-transition race: the settings read is still in flight when the
    // effect tears down (uid change → clearUserCaches purge). The late result
    // must not write the departing account's values into the purged keys.
    let release!: (v: Partial<SyncedSettings>) => void;
    const { source, getSyncedSettings } = makeSource({});
    getSyncedSettings.mockImplementation(
      () => new Promise<Partial<SyncedSettings>>((resolve) => (release = resolve)),
    );
    const view = mount(source);
    await flush();
    expect(getSyncedSettings).toHaveBeenCalledTimes(1);

    view.unmount();
    release({ itemSort: 'oldest' });
    await flush();

    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBeNull();
    expect(window.localStorage.getItem(ackedSettingsKey(DEMO_UID))).toBeNull();
  });

  it('survives a failing backend and retries the pending change on the next trigger', async () => {
    const { source, setSyncedSettings } = makeSource({});
    setSyncedSettings.mockRejectedValueOnce(new Error('offline'));
    mount(source);
    await flush();

    window.localStorage.setItem(ITEM_SORT_KEY, 'oldest');
    window.dispatchEvent(new Event(READING_PREF_CHANGE_EVENT));
    await flush(SETTINGS_PUSH_DEBOUNCE_MS + 50);
    expect(setSyncedSettings).toHaveBeenCalledTimes(1); // failed, still pending

    act(() => {
      window.dispatchEvent(new Event('online'))
    });
    await flush();
    expect(setSyncedSettings).toHaveBeenCalledTimes(2);
    expect(setSyncedSettings).toHaveBeenLastCalledWith({ itemSort: 'oldest' });
  });
});
