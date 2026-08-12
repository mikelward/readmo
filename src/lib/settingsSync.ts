// Per-account reading-behavior settings sync (SPEC.md *Settings* → scope).
//
// The reading-behavior preferences (sort order, group by feed, mark-done-on-
// scroll and what it does with the row, favicon toggles, spoiler hiding,
// auto-summarize) are ACCOUNT intent,
// not device ergonomics, so they sync across devices via the `user_settings`
// table (0064). Appearance (theme/palette/text size/font), the bottom-toolbar
// position, the app-wide article-layout default, and diagnostics stay
// device-local — see SPEC.md for the product-level split.
//
// Sync design: localStorage stays the source the UI reads synchronously (the
// prefs shape the very first paint, so a server round-trip can never be on
// that path — same reasoning as the item-state store), and this module layers
// an async reconcile on top:
//
//   - The engine keeps a per-user "acked" snapshot (`readmo:settings-acked:
//     <uid>`) of the last values the server confirmed. A local value that
//     differs from its acked value is a PENDING user action; one that matches
//     is settled — unless it carries a DIRTY marker (`readmo:settings-dirty`,
//     stamped by the pref setters in useReadingPrefs): a user flip that ends
//     back on the acked value (on→off in one Settings visit) is still the
//     newest action for that setting, and value equality alone would let a
//     fetched cross-device value overwrite it (Codex P2 on #494). Dirty keys
//     are pushed regardless of value and shielded from reconcile's apply until
//     the push lands.
//   - `push()` sends the pending diff (only the changed columns) and advances
//     the snapshot on success. A failed push leaves the snapshot alone, so the
//     diff stays pending and retries on the next change/online/focus.
//   - `reconcile()` fetches the server row, applies each server value the
//     device has no pending change for (writing localStorage + dispatching the
//     shared change event so mounted stores re-read), then pushes whatever is
//     pending. Pending local values are never overwritten — they are the
//     user's newest action and win until acknowledged.
//
// Two devices editing the SAME setting resolve last-write-wins per column
// (each push carries only its changed columns); different settings never
// clobber each other. The snapshot lives in localStorage (not memory) so all
// tabs share one ack state and don't re-push each other's writes.
//
// On sign-out or account switch the synced keys and the snapshot are purged
// with the rest of the departing user's on-device data (userCache, guardrail
// #8) — the next account hydrates its own values from the server.

/** The settings that sync per account. Value types match the stores in
 * hooks/useReadingPrefs (`itemSort` mirrors DataSource.ItemSort). */
export interface SyncedSettings {
  itemSort: 'newest' | 'oldest';
  groupByFeed: boolean;
  hideOnScroll: boolean;
  hideOnScrollRemove: boolean;
  showRowFavicon: boolean;
  showGroupFavicon: boolean;
  hideSportsSpoilers: boolean;
  autoSummarizePinned: boolean;
  /** Normalized filtered words (src/lib/titleFilter.ts). The only non-scalar
   * synced setting: it resolves last-write-wins over the WHOLE list rather
   * than per word, which is the accepted trade for a list edited a few times
   * a year (see 0071's header). */
  titleFilters: string[];
}

export type SyncedSettingKey = keyof SyncedSettings;

// Canonical storage keys for the synced prefs. hooks/useReadingPrefs re-exports
// these under their historical names; userCache purges them on account change.
export const ITEM_SORT_KEY = 'readmo:item-sort';
export const GROUP_BY_FEED_KEY = 'readmo:group-by-feed';
export const HIDE_ON_SCROLL_KEY = 'readmo:hide-on-scroll';
export const HIDE_ON_SCROLL_REMOVE_KEY = 'readmo:hide-on-scroll-remove';
export const SHOW_ROW_FAVICON_KEY = 'readmo:show-row-favicon';
export const SHOW_GROUP_FAVICON_KEY = 'readmo:show-group-favicon';
export const HIDE_SPORTS_SPOILERS_KEY = 'readmo:hide-sports-spoilers';
export const AUTO_SUMMARIZE_PINNED_KEY = 'readmo:auto-summarize-pinned';
export const TITLE_FILTERS_KEY = 'readmo:title-filters';

/** The change event every reading-pref store dispatches on set (and the sync
 * engine dispatches after applying server values), so all mounted stores —
 * and the push scheduler — re-read. */
export const READING_PREF_CHANGE_EVENT = 'readmo:reading-pref-changed';

interface SettingSpec<T> {
  storageKey: string;
  /** Parse a stored string, or undefined for garbage (treated as unset). */
  parse: (raw: string) => T | undefined;
  serialize: (value: T) => string;
  /** Value equality, for the scalar settings just identity. A NON-SCALAR
   * setting must supply this: every comparison below (is this pending? did the
   * server value differ? did the local value change while the write was in
   * flight?) is a value question, and identity answers it wrong for an array —
   * a freshly parsed list never equals its stored twin, so the setting would
   * read as permanently pending and re-push on every scheduler tick, forever. */
  equals?: (a: T, b: T) => boolean;
}

const boolSpec = (storageKey: string): SettingSpec<boolean> => ({
  storageKey,
  parse: (raw) => (raw === '1' ? true : raw === '0' ? false : undefined),
  serialize: (value) => (value ? '1' : '0'),
});

/** Per-key storage bindings, shared with the useReadingPrefs stores so the
 * engine and the hooks can never disagree on a key's encoding. */
export const SYNCED_SETTINGS: {
  [K in SyncedSettingKey]: SettingSpec<SyncedSettings[K]>;
} = {
  itemSort: {
    storageKey: ITEM_SORT_KEY,
    parse: (raw) => (raw === 'newest' || raw === 'oldest' ? raw : undefined),
    serialize: (value) => value,
  },
  groupByFeed: boolSpec(GROUP_BY_FEED_KEY),
  hideOnScroll: boolSpec(HIDE_ON_SCROLL_KEY),
  hideOnScrollRemove: boolSpec(HIDE_ON_SCROLL_REMOVE_KEY),
  showRowFavicon: boolSpec(SHOW_ROW_FAVICON_KEY),
  showGroupFavicon: boolSpec(SHOW_GROUP_FAVICON_KEY),
  hideSportsSpoilers: boolSpec(HIDE_SPORTS_SPOILERS_KEY),
  autoSummarizePinned: boolSpec(AUTO_SUMMARIZE_PINNED_KEY),
  titleFilters: {
    storageKey: TITLE_FILTERS_KEY,
    // JSON rather than a delimiter: an entry is arbitrary reader-typed text,
    // and any separator character could appear inside one.
    parse: (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return undefined;
      }
      if (!Array.isArray(parsed)) return undefined;
      return parsed.every((e) => typeof e === 'string') ? (parsed as string[]) : undefined;
    },
    serialize: (value) => JSON.stringify(value),
    equals: (a, b) => a.length === b.length && a.every((entry, i) => entry === b[i]),
  },
};

const SYNCED_KEYS = Object.keys(SYNCED_SETTINGS) as SyncedSettingKey[];

/** Every synced pref's localStorage key — the purge list for userCache. */
export const SYNCED_SETTINGS_STORAGE_KEYS: readonly string[] = SYNCED_KEYS.map(
  (k) => SYNCED_SETTINGS[k].storageKey,
);

/** Prefix of every per-user acked snapshot key — userCache sweeps ALL keys
 * under it whenever the (global) synced pref keys are wiped, so no account can
 * ever meet a leftover snapshot that no longer matches the wiped prefs (a
 * stale ack would make a fresh flip to the acked value look already-delivered,
 * and a later reconcile would overwrite the user's change — Codex P2 on #494). */
/** Fired when this device and the server AGREE on a set of settings
 * (`detail.keys`) — either because a push was acknowledged, or because a
 * reconcile adopted the server's value. Distinct from
 * READING_PREF_CHANGE_EVENT, which fires on the local write: the gap between
 * them is the push debounce plus a round trip, so anything that must read
 * SERVER truth (a refetch whose result depends on a server-side setting) has to
 * wait for this one. Both emitters matter — keying only on the push half means
 * a list changed on another device updates the local overlay and never
 * refetches (Codex P2 on #625). */
export const SETTINGS_SYNCED_EVENT = 'readmo:settings-synced';

export const ACKED_SETTINGS_KEY_PREFIX = 'readmo:settings-acked:';

/** The dirty-marker set: keys of settings the user has changed on this device
 * that no push has confirmed since. Global like the pref keys themselves (and
 * purged with them — userCache), shared across tabs. Needed because the acked
 * VALUE can't tell "settled" from "flipped away and back": a toggle that ends
 * on the acked value is still the newest action and must win over a fetched
 * cross-device value until it's pushed. */
export const DIRTY_SETTINGS_KEY = 'readmo:settings-dirty';

/** The per-user last-server-acknowledged snapshot key (purged with the user's
 * other on-device data on sign-out/account switch). */
export function ackedSettingsKey(uid: string): string {
  return `${ACKED_SETTINGS_KEY_PREFIX}${uid}`;
}

/** What the engine needs from the backend. Both calls come from the optional
 * DataSource methods: `get` resolves null when the backend can't serve
 * settings (old backend / transient failure — nothing applied, push still
 * attempted); `set` throws on a transient failure so the diff stays pending. */
export interface SettingsTransport {
  get(): Promise<Partial<SyncedSettings> | null>;
  set(patch: Partial<SyncedSettings>): Promise<void>;
}

export interface SettingsSyncEngine {
  /** Fetch server values, apply the non-pending ones locally, then push any
   * pending local changes. Serialized with push(). */
  reconcile(): Promise<void>;
  /** Push the local-vs-acked diff (no-op when settled). Serialized. */
  push(): Promise<void>;
  /** Permanently stop the engine: in-flight and future ops become no-ops
   * before their next side effect. Called from the owning hook's cleanup so a
   * slow reconcile started under a departing account can't write that
   * account's values back into the just-purged pref keys (guardrail #8), and
   * a chained push can't fire under the next session's auth (Codex P2 on
   * #494). A transport call already on the wire can't be recalled, but its
   * result is discarded — nothing is applied or acked after this. */
  cancel(): void;
}

/** Whether two values of a setting are the same, per its spec (identity for
 * the scalars, structural for a list — see SettingSpec.equals). Both sides may
 * be absent, which compares equal only to another absence. */
function sameValue<K extends SyncedSettingKey>(
  key: K,
  a: SyncedSettings[K] | undefined,
  b: SyncedSettings[K] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const equals = SYNCED_SETTINGS[key].equals as
    | ((x: SyncedSettings[K], y: SyncedSettings[K]) => boolean)
    | undefined;
  return equals ? equals(a, b) : Object.is(a, b);
}

/** A value is well-formed iff it round-trips its own encoding — guards the
 * JSON snapshot (and the transport's output) against foreign shapes. */
function isValid<K extends SyncedSettingKey>(
  key: K,
  value: unknown,
): value is SyncedSettings[K] {
  const spec = SYNCED_SETTINGS[key];
  try {
    const round = spec.parse(spec.serialize(value as SyncedSettings[K]));
    return round !== undefined && sameValue(key, round as SyncedSettings[K], value as SyncedSettings[K]);
  } catch {
    return false;
  }
}

function readDirty(): Set<SyncedSettingKey> {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(DIRTY_SETTINGS_KEY);
  } catch {
    return new Set();
  }
  if (raw === null) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(
    parsed.filter((k): k is SyncedSettingKey => SYNCED_KEYS.includes(k)),
  );
}

function writeDirty(dirty: ReadonlySet<SyncedSettingKey>): void {
  try {
    if (dirty.size === 0) {
      window.localStorage.removeItem(DIRTY_SETTINGS_KEY);
    } else {
      window.localStorage.setItem(DIRTY_SETTINGS_KEY, JSON.stringify([...dirty]));
    }
  } catch {
    // best-effort — see writeAcked
  }
}

/** Record that the user changed `key` on this device. Called by the pref
 * setters (useReadingPrefs) BEFORE the store write dispatches the change
 * event, so the push the event schedules already sees the marker. The engine
 * clears it once a push confirms the value. */
export function markSettingDirty(key: SyncedSettingKey): void {
  const dirty = readDirty();
  if (dirty.has(key)) return;
  dirty.add(key);
  writeDirty(dirty);
}

function readAcked(uid: string): Partial<SyncedSettings> {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(ackedSettingsKey(uid));
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const out: Partial<SyncedSettings> = {};
  for (const key of SYNCED_KEYS) {
    const v = (parsed as Record<string, unknown>)[key];
    if (isValid(key, v)) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

function writeAcked(uid: string, acked: Partial<SyncedSettings>): void {
  try {
    window.localStorage.setItem(ackedSettingsKey(uid), JSON.stringify(acked));
  } catch {
    // Storage unavailable/full — the ack is best-effort; worst case the same
    // values get re-pushed later (idempotent).
  }
}

/** Current local values, PRESENT keys only: an absent (or garbage) raw string
 * means the pref was never touched on this device — no opinion to push, and a
 * server value may be applied over it. */
function readLocal(): Partial<SyncedSettings> {
  const out: Partial<SyncedSettings> = {};
  for (const key of SYNCED_KEYS) {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(SYNCED_SETTINGS[key].storageKey);
    } catch {
      return {};
    }
    if (raw === null) continue;
    const parsed = SYNCED_SETTINGS[key].parse(raw);
    if (parsed !== undefined) (out as Record<string, unknown>)[key] = parsed;
  }
  return out;
}

export function createSettingsSyncEngine(
  uid: string,
  transport: SettingsTransport,
): SettingsSyncEngine {
  // Serialize reconciles/pushes so a reconcile's apply can't interleave with a
  // push's diff (both read-modify-write the acked snapshot).
  let chain: Promise<void> = Promise.resolve();
  const run = (op: () => Promise<void>): Promise<void> => {
    const next = chain.then(op, op);
    chain = next.catch(() => {});
    return next;
  };

  // Once set, every op bails before its next side effect (checked again after
  // each await — a cancel can land while a transport call is in flight).
  let cancelled = false;

  async function doPush(): Promise<void> {
    if (cancelled) return;
    const acked = readAcked(uid);
    const local = readLocal();
    const dirty = readDirty();
    const patch: Partial<SyncedSettings> = {};
    for (const key of SYNCED_KEYS) {
      const lv = local[key];
      if (lv === undefined) continue;
      // Dirty keys push even when the value matches the ack — a flip that
      // ended back on the acked value is still the newest action for the
      // setting and must reach the server to win the cross-device race.
      if (dirty.has(key) || !sameValue(key, lv, acked[key])) {
        (patch as Record<string, unknown>)[key] = lv;
      }
    }
    if (Object.keys(patch).length === 0) return;
    await transport.set(patch); // throws → snapshot untouched, diff stays pending
    // Don't ack into purged storage: a cancel during the write means an auth
    // transition is tearing this scope down; the snapshot key is being purged
    // and must not be resurrected.
    if (cancelled) return;
    writeAcked(uid, { ...readAcked(uid), ...patch });
    // Announce what the SERVER now has. A local store change is not the same
    // event: anything that must act on server truth (useFeedInvalidation's
    // refetch, which would otherwise re-read the feed with the old filters
    // still applied and mark it fresh) has to wait for this, 400 ms of debounce
    // plus a round trip later. Dispatched after writeAcked so a listener that
    // reads the snapshot sees the acked values, and only for keys actually
    // sent, so an unrelated push wakes nobody.
    window.dispatchEvent(
      new CustomEvent(SETTINGS_SYNCED_EVENT, {
        detail: { keys: Object.keys(patch) as SyncedSettingKey[] },
      }),
    );
    // Clear a pushed key's dirty marker only while its local value still
    // matches what was sent — a flip made while the write was in flight is a
    // NEW action that must stay dirty for the next push.
    const dirtyNow = readDirty();
    const localNow = readLocal();
    let dirtyChanged = false;
    for (const key of Object.keys(patch) as SyncedSettingKey[]) {
      if (dirtyNow.has(key) && sameValue(key, localNow[key], patch[key])) {
        dirtyNow.delete(key);
        dirtyChanged = true;
      }
    }
    if (dirtyChanged) writeDirty(dirtyNow);
  }

  async function doReconcile(): Promise<void> {
    if (cancelled) return;
    const server = await transport.get();
    // A cancel that landed while the read was in flight: applying now would
    // write the departing account's values into pref keys clearUserCaches just
    // purged, leaking them to the next account (guardrail #8).
    if (cancelled) return;
    if (server !== null) {
      const acked = readAcked(uid);
      const local = readLocal();
      const dirty = readDirty();
      const apply: Array<[SyncedSettingKey, SyncedSettings[SyncedSettingKey]]> =
        [];
      for (const key of SYNCED_KEYS) {
        const sv = server[key];
        if (sv === undefined || !isValid(key, sv)) continue;
        const lv = local[key];
        // A local value that differs from its ack — or one the user touched
        // since the last confirmed push (dirty), even if it landed back on the
        // acked value — is an unpushed user action, newer than anything
        // fetched, so the server value must not clobber it; doPush below sends
        // it instead.
        if (lv !== undefined && (dirty.has(key) || !sameValue(key, lv, acked[key]))) continue;
        (acked as Record<string, unknown>)[key] = sv;
        if (!sameValue(key, lv, sv)) apply.push([key, sv]);
      }
      // Ack BEFORE applying: the change event below wakes the push scheduler,
      // and with the snapshot already advanced its diff is empty (no echo).
      writeAcked(uid, acked);
      if (apply.length > 0) {
        try {
          for (const [key, value] of apply) {
            window.localStorage.setItem(
              SYNCED_SETTINGS[key].storageKey,
              SYNCED_SETTINGS[key].serialize(value as never),
            );
          }
        } catch {
          // Storage unavailable — the stores keep their defaults.
        }
        window.dispatchEvent(new Event(READING_PREF_CHANGE_EVENT));
        // Adopting the server's value is the OTHER way this device and the
        // server come to agree, and a listener that needs server truth cares
        // about it identically. Emitting only from doPush would mean a list
        // changed on another device updates the local overlay and never
        // refetches — the rows the server excluded stay missing, and the ones a
        // removal should restore never arrive (Codex P2 on #625). doPush below
        // sends an empty patch here (the ack was already advanced), so it emits
        // nothing and there is no double-fire.
        window.dispatchEvent(
          new CustomEvent(SETTINGS_SYNCED_EVENT, {
            detail: { keys: apply.map(([key]) => key) },
          }),
        );
      }
    }
    await doPush();
  }

  return {
    reconcile: () => run(doReconcile),
    push: () => run(doPush),
    cancel: () => {
      cancelled = true;
    },
  };
}
