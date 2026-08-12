import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ackedSettingsKey,
  createSettingsSyncEngine,
  DIRTY_SETTINGS_KEY,
  GROUP_BY_FEED_KEY,
  HIDE_SPORTS_SPOILERS_KEY,
  TITLE_FILTERS_KEY,
  SETTINGS_SYNCED_EVENT,
  ITEM_SORT_KEY,
  markSettingDirty,
  READING_PREF_CHANGE_EVENT,
  SHOW_GROUP_FAVICON_KEY,
  SYNCED_SETTINGS_STORAGE_KEYS,
  type SettingsTransport,
  type SyncedSettings,
} from './settingsSync';

const UID = 'u1';

function makeTransport(overrides?: Partial<SettingsTransport>): {
  transport: SettingsTransport;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn<() => Promise<Partial<SyncedSettings> | null>>(
    async () => ({}),
  );
  const set = vi.fn<(patch: Partial<SyncedSettings>) => Promise<void>>(
    async () => {},
  );
  const transport = {
    get: overrides?.get ?? get,
    set: overrides?.set ?? set,
  };
  return { transport, get, set };
}

function acked(): Record<string, unknown> {
  const raw = window.localStorage.getItem(ackedSettingsKey(UID));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('createSettingsSyncEngine.reconcile', () => {
  it('applies server values to localStorage, dispatches the pref change event, and acks them', async () => {
    const { transport, get } = makeTransport();
    get.mockResolvedValue({ itemSort: 'oldest', groupByFeed: true });
    const onChange = vi.fn();
    window.addEventListener(READING_PREF_CHANGE_EVENT, onChange);

    const engine = createSettingsSyncEngine(UID, transport);
    await engine.reconcile();

    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBe('oldest');
    expect(window.localStorage.getItem(GROUP_BY_FEED_KEY)).toBe('1');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(acked()).toEqual({ itemSort: 'oldest', groupByFeed: true });
    window.removeEventListener(READING_PREF_CHANGE_EVENT, onChange);
  });

  it('never overwrites a pending local change; pushes it instead (local action is newest)', async () => {
    // The device flipped hide-sports-spoilers off, but the push hasn't been
    // acknowledged (nothing acked). The server still says on.
    window.localStorage.setItem(HIDE_SPORTS_SPOILERS_KEY, '0');
    const { transport, get, set } = makeTransport();
    get.mockResolvedValue({ hideSportsSpoilers: true, groupByFeed: true });

    const engine = createSettingsSyncEngine(UID, transport);
    await engine.reconcile();

    // The pending local value survives and is pushed; the untouched setting is
    // adopted from the server.
    expect(window.localStorage.getItem(HIDE_SPORTS_SPOILERS_KEY)).toBe('0');
    expect(window.localStorage.getItem(GROUP_BY_FEED_KEY)).toBe('1');
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ hideSportsSpoilers: false });
    expect(acked()).toEqual({ hideSportsSpoilers: false, groupByFeed: true });
  });

  // A list is the one non-scalar synced setting, so every comparison in the
  // engine that used identity had to become a value comparison. Identity says
  // "changed" for a freshly parsed array every single time, which would make
  // the setting permanently pending: re-pushed on every scheduler tick, forever,
  // and never adoptable from another device.
  it('settles a filter list rather than re-pushing it forever', async () => {
    window.localStorage.setItem(TITLE_FILTERS_KEY, JSON.stringify(['trump']));
    const { transport, set } = makeTransport();

    const engine = createSettingsSyncEngine(UID, transport);
    await engine.reconcile();
    expect(set).toHaveBeenCalledWith({ titleFilters: ['trump'] });
    expect(acked()).toEqual({ titleFilters: ['trump'] });

    // Second pass with nothing changed: the equal-but-not-identical list must
    // read as settled, so there is no diff left to send.
    set.mockClear();
    await engine.reconcile();
    expect(set).not.toHaveBeenCalled();
  });

  it('adopts a filter list from another device when the local one is settled', async () => {
    window.localStorage.setItem(TITLE_FILTERS_KEY, JSON.stringify(['trump']));
    window.localStorage.setItem(
      ackedSettingsKey(UID),
      JSON.stringify({ titleFilters: ['trump'] }),
    );
    const { transport, get, set } = makeTransport();
    get.mockResolvedValue({ titleFilters: ['trump', 'musk'] });

    const engine = createSettingsSyncEngine(UID, transport);
    await engine.reconcile();

    expect(window.localStorage.getItem(TITLE_FILTERS_KEY)).toBe(
      JSON.stringify(['trump', 'musk']),
    );
    expect(set).not.toHaveBeenCalled();
  });

  it('keeps a pending local filter list rather than adopting the server one', async () => {
    window.localStorage.setItem(TITLE_FILTERS_KEY, JSON.stringify(['trump', 'musk']));
    const { transport, get, set } = makeTransport();
    get.mockResolvedValue({ titleFilters: ['tariffs'] });

    const engine = createSettingsSyncEngine(UID, transport);
    await engine.reconcile();

    expect(window.localStorage.getItem(TITLE_FILTERS_KEY)).toBe(
      JSON.stringify(['trump', 'musk']),
    );
    expect(set).toHaveBeenCalledWith({ titleFilters: ['trump', 'musk'] });
  });

  it('adopts a server change for a setting whose local value is settled (acked)', async () => {
    // A previous session pushed groupByFeed=false; another device then turned
    // it on. Local == acked, so the server value wins here.
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '0');
    window.localStorage.setItem(
      ackedSettingsKey(UID),
      JSON.stringify({ groupByFeed: false }),
    );
    const { transport, get } = makeTransport();
    get.mockResolvedValue({ groupByFeed: true });

    await createSettingsSyncEngine(UID, transport).reconcile();

    expect(window.localStorage.getItem(GROUP_BY_FEED_KEY)).toBe('1');
    expect(acked()).toEqual({ groupByFeed: true });
  });

  it('seeds the server from local values on the first reconcile of an upgrading device', async () => {
    // Pre-sync install: prefs exist locally, nothing acked, empty server row.
    window.localStorage.setItem(ITEM_SORT_KEY, 'oldest');
    window.localStorage.setItem(SHOW_GROUP_FAVICON_KEY, '0');
    const { transport, set } = makeTransport();

    await createSettingsSyncEngine(UID, transport).reconcile();

    expect(set).toHaveBeenCalledWith({
      itemSort: 'oldest',
      showGroupFavicon: false,
    });
    expect(acked()).toEqual({ itemSort: 'oldest', showGroupFavicon: false });
  });

  it('applies nothing when the transport reports the backend cannot serve settings (null)', async () => {
    const { transport, get, set } = makeTransport();
    get.mockResolvedValue(null);

    await createSettingsSyncEngine(UID, transport).reconcile();

    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBeNull();
    expect(acked()).toEqual({});
    expect(set).not.toHaveBeenCalled();
  });

  it('drops malformed server values instead of writing them into the stores', async () => {
    const { transport, get } = makeTransport();
    get.mockResolvedValue({
      itemSort: 'sideways',
      groupByFeed: 'yes',
    } as unknown as Partial<SyncedSettings>);

    await createSettingsSyncEngine(UID, transport).reconcile();

    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBeNull();
    expect(window.localStorage.getItem(GROUP_BY_FEED_KEY)).toBeNull();
    expect(acked()).toEqual({});
  });

  it('surfaces a fetch failure to the caller without touching local state', async () => {
    window.localStorage.setItem(ITEM_SORT_KEY, 'oldest');
    const { transport, get } = makeTransport();
    get.mockRejectedValue(new Error('offline'));

    await expect(
      createSettingsSyncEngine(UID, transport).reconcile(),
    ).rejects.toThrow('offline');
    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBe('oldest');
    expect(acked()).toEqual({});
  });
});

describe('createSettingsSyncEngine.push', () => {
  it('pushes only the local-vs-acked diff and advances the ack on success', async () => {
    window.localStorage.setItem(ITEM_SORT_KEY, 'oldest');
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '1');
    window.localStorage.setItem(
      ackedSettingsKey(UID),
      JSON.stringify({ groupByFeed: true }),
    );
    const { transport, set } = makeTransport();

    await createSettingsSyncEngine(UID, transport).push();

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ itemSort: 'oldest' });
    expect(acked()).toEqual({ groupByFeed: true, itemSort: 'oldest' });
  });

  it('is a no-op when everything local is acked (no echo after hydration)', async () => {
    const { transport, get, set } = makeTransport();
    get.mockResolvedValue({ itemSort: 'oldest' });
    const engine = createSettingsSyncEngine(UID, transport);
    await engine.reconcile(); // hydration writes localStorage + acks

    await engine.push();

    expect(set).not.toHaveBeenCalled();
  });

  it('keeps the diff pending when the push fails, so it retries later', async () => {
    window.localStorage.setItem(ITEM_SORT_KEY, 'oldest');
    const { transport, set } = makeTransport();
    set.mockRejectedValueOnce(new Error('offline'));
    const engine = createSettingsSyncEngine(UID, transport);

    await expect(engine.push()).rejects.toThrow('offline');
    expect(acked()).toEqual({}); // not acked — still pending

    await engine.push(); // e.g. the `online` trigger
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith({ itemSort: 'oldest' });
    expect(acked()).toEqual({ itemSort: 'oldest' });
  });

  it('ignores prefs never touched on this device (absent keys carry no opinion)', async () => {
    const { transport, set } = makeTransport();
    await createSettingsSyncEngine(UID, transport).push();
    expect(set).not.toHaveBeenCalled();
  });

  it('announces the pushed keys once the server has acknowledged them', async () => {
    // The other half of useFeedInvalidation's contract: the feed refetch keys
    // on this event rather than on the local write, because the push is a
    // debounce plus a round trip behind it and a refetch fired early reads the
    // server's OLD values and marks the query fresh (Codex P1 on #625).
    window.localStorage.setItem(TITLE_FILTERS_KEY, JSON.stringify(['trump']));
    const { transport, set } = makeTransport();
    const pushed = vi.fn();
    window.addEventListener(SETTINGS_SYNCED_EVENT, pushed);

    await createSettingsSyncEngine(UID, transport).push();

    window.removeEventListener(SETTINGS_SYNCED_EVENT, pushed);
    expect(set).toHaveBeenCalledWith({ titleFilters: ['trump'] });
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(
      (pushed.mock.calls[0][0] as CustomEvent<{ keys: string[] }>).detail.keys,
    ).toEqual(['titleFilters']);
  });

  it('announces keys adopted from another device, not just pushed ones', async () => {
    // Both halves of "this device and the server now agree". Emitting only on
    // push meant a list changed on another device updated the local overlay and
    // never refetched, so the rows the server excluded stayed missing (Codex P2
    // on #625).
    const { transport, get } = makeTransport();
    get.mockResolvedValue({ titleFilters: ['musk'] });
    const synced = vi.fn();
    window.addEventListener(SETTINGS_SYNCED_EVENT, synced);

    await createSettingsSyncEngine(UID, transport).reconcile();

    window.removeEventListener(SETTINGS_SYNCED_EVENT, synced);
    expect(window.localStorage.getItem(TITLE_FILTERS_KEY)).toBe(
      JSON.stringify(['musk']),
    );
    // Exactly once: the ack is advanced before the apply, so the push that
    // follows has an empty patch and emits nothing.
    expect(synced).toHaveBeenCalledTimes(1);
    expect(
      (synced.mock.calls[0][0] as CustomEvent<{ keys: string[] }>).detail.keys,
    ).toEqual(['titleFilters']);
  });

  it('announces nothing when a reconcile changes no local value', async () => {
    // A hydration that agrees with what's already here must not reflow the feed.
    window.localStorage.setItem(TITLE_FILTERS_KEY, JSON.stringify(['musk']));
    window.localStorage.setItem(
      ackedSettingsKey(UID),
      JSON.stringify({ titleFilters: ['musk'] }),
    );
    const { transport, get } = makeTransport();
    get.mockResolvedValue({ titleFilters: ['musk'] });
    const synced = vi.fn();
    window.addEventListener(SETTINGS_SYNCED_EVENT, synced);

    await createSettingsSyncEngine(UID, transport).reconcile();

    window.removeEventListener(SETTINGS_SYNCED_EVENT, synced);
    expect(synced).not.toHaveBeenCalled();
  });

  it('does not announce a push the server rejected', async () => {
    // Nothing to refetch against: the server still holds the old list, so an
    // event here would send the feed to re-read exactly what it already has.
    window.localStorage.setItem(TITLE_FILTERS_KEY, JSON.stringify(['trump']));
    const { transport, set } = makeTransport();
    set.mockRejectedValueOnce(new Error('offline'));
    const pushed = vi.fn();
    window.addEventListener(SETTINGS_SYNCED_EVENT, pushed);

    await expect(createSettingsSyncEngine(UID, transport).push()).rejects.toThrow(
      'offline',
    );

    window.removeEventListener(SETTINGS_SYNCED_EVENT, pushed);
    expect(pushed).not.toHaveBeenCalled();
  });
});

describe('dirty markers (a flip back to the acked value is still the newest action)', () => {
  it('reconcile never applies a server value over a dirty key, and pushes the local value instead', async () => {
    // Device A acked groupByFeed=false; device B set it true server-side.
    // The user then toggled A on→off (net value back at the ack). A's action
    // is newest — the fetched true must not clobber it.
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '0');
    window.localStorage.setItem(
      ackedSettingsKey(UID),
      JSON.stringify({ groupByFeed: false }),
    );
    markSettingDirty('groupByFeed');
    const { transport, get, set } = makeTransport();
    get.mockResolvedValue({ groupByFeed: true });

    await createSettingsSyncEngine(UID, transport).reconcile();

    expect(window.localStorage.getItem(GROUP_BY_FEED_KEY)).toBe('0');
    expect(set).toHaveBeenCalledWith({ groupByFeed: false });
    // Confirmed push clears the marker and re-acks the pushed value.
    expect(window.localStorage.getItem(DIRTY_SETTINGS_KEY)).toBeNull();
    expect(acked()).toEqual({ groupByFeed: false });
  });

  it('a dirty key stays pending across a failed push', async () => {
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '0');
    window.localStorage.setItem(
      ackedSettingsKey(UID),
      JSON.stringify({ groupByFeed: false }),
    );
    markSettingDirty('groupByFeed');
    const { transport, set } = makeTransport();
    set.mockRejectedValueOnce(new Error('offline'));
    const engine = createSettingsSyncEngine(UID, transport);

    await expect(engine.push()).rejects.toThrow('offline');
    expect(window.localStorage.getItem(DIRTY_SETTINGS_KEY)).toBe(
      '["groupByFeed"]',
    );

    await engine.push();
    expect(set).toHaveBeenLastCalledWith({ groupByFeed: false });
    expect(window.localStorage.getItem(DIRTY_SETTINGS_KEY)).toBeNull();
  });

  it('keeps a key dirty when it was flipped again while the push was in flight', async () => {
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '1');
    markSettingDirty('groupByFeed');
    let release!: () => void;
    const { transport, set } = makeTransport();
    set.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const engine = createSettingsSyncEngine(UID, transport);
    const push = engine.push();
    await vi.waitFor(() => expect(set).toHaveBeenCalled());

    // A new user action lands while the write is on the wire.
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '0');
    markSettingDirty('groupByFeed');
    release();
    await push;

    // The in-flight value was acked, but the newer flip must stay dirty so
    // the next push sends it.
    expect(acked()).toEqual({ groupByFeed: true });
    expect(window.localStorage.getItem(DIRTY_SETTINGS_KEY)).toBe(
      '["groupByFeed"]',
    );
  });
});

describe('createSettingsSyncEngine.cancel', () => {
  it('discards a fetch that resolves after cancel — nothing applied or acked', async () => {
    // The auth-transition race: reconcile's read is in flight when the hook
    // unmounts and clearUserCaches purges the pref keys. The late result must
    // not write the departing account's values back (guardrail #8).
    let release!: (v: Partial<SyncedSettings>) => void;
    const { transport, get } = makeTransport();
    get.mockImplementation(
      () =>
        new Promise<Partial<SyncedSettings>>((resolve) => (release = resolve)),
    );
    const engine = createSettingsSyncEngine(UID, transport);
    const reconcile = engine.reconcile();
    // The engine defers ops onto its chain; wait for the read to be in flight
    // (release assigned) before cancelling.
    await vi.waitFor(() => expect(get).toHaveBeenCalled());

    engine.cancel();
    release({ itemSort: 'oldest' });
    await reconcile;

    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBeNull();
    expect(acked()).toEqual({});
  });

  it('does not ack a push whose write was in flight when cancel landed', async () => {
    window.localStorage.setItem(ITEM_SORT_KEY, 'oldest');
    let release!: () => void;
    const { transport, set } = makeTransport();
    set.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const engine = createSettingsSyncEngine(UID, transport);
    const push = engine.push();
    // Wait for the write to be in flight (release assigned) before cancelling.
    await vi.waitFor(() => expect(set).toHaveBeenCalled());

    engine.cancel();
    release();
    await push;

    // The write may have landed server-side, but the snapshot key is being
    // purged — never resurrect it. Worst case the same value re-pushes later
    // (idempotent).
    expect(acked()).toEqual({});
  });

  it('makes later ops no-ops entirely (no transport calls)', async () => {
    window.localStorage.setItem(ITEM_SORT_KEY, 'oldest');
    const { transport, get, set } = makeTransport();
    const engine = createSettingsSyncEngine(UID, transport);
    engine.cancel();

    await engine.reconcile();
    await engine.push();

    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('exports', () => {
  it('lists every synced storage key for the userCache purge', () => {
    expect(SYNCED_SETTINGS_STORAGE_KEYS).toEqual(
      expect.arrayContaining([
        ITEM_SORT_KEY,
        GROUP_BY_FEED_KEY,
        HIDE_SPORTS_SPOILERS_KEY,
        SHOW_GROUP_FAVICON_KEY,
      ]),
    );
    // The purge list is derived from SYNCED_SETTINGS, so this length is the
    // guard that adding a synced pref can't quietly skip the account-change
    // wipe (guardrail #8) — bump it deliberately when you add one.
    expect(SYNCED_SETTINGS_STORAGE_KEYS).toHaveLength(9);
  });
});
