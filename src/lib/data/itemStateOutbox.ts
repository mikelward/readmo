import type { ItemId, ItemStateField } from '../types';

// Offline mutation outbox for item-state writes (SPEC.md *Sync → Offline
// mutation outbox*). Triage toggles update the local ItemStateStore optimistically
// for instant UI; this outbox owns durable delivery to the server:
//
//  - persisted, so a write made offline (or interrupted by a reload) survives and
//    replays on the next boot/reconnect;
//  - coalesced per item — the merged changed-field set is sent, so a Pin→Unpin
//    burst collapses to one write carrying the final values;
//  - serialized per item via a single drain loop, so writes can't reorder;
//  - retried on reconnect; a *transient* (network) failure keeps the entry queued,
//    while a *permanent* server rejection (e.g. lost visibility, or a version
//    conflict) drops it and asks the caller to re-reconcile from server truth.
//
// Optimistic concurrency (SPEC.md *Sync → Conflict resolution*): each queued
// write carries the server `version` its change was based on. The send path
// passes it to `set_item_state`, which applies the write only if the row is
// still at that version, else rejects (a stale offline replay then reconciles
// instead of clobbering a newer change from another device). The base is
// snapshotted when an item first goes pending and advances to the server's
// returned version after each successful write, so sequential edits don't
// false-conflict; a conflict is permanent → the entry (and any newer queued
// edits for it) is dropped and the store rolls back to server truth.
//
// `pendingIds()` lets the hydrate path preserve un-synced local rows while
// clearing genuinely-stale ones (closing the "clear local states absent from
// hydration" gap without a data-loss race).

export type ChangedFields = Partial<Record<ItemStateField, boolean>>;

interface OutboxEntry {
  id: ItemId;
  changed: ChangedFields;
  /** Server version the change is based on (see optimistic concurrency above).
   * Absent for legacy persisted entries → sent as null (no check). */
  base?: number | null;
}

export interface OutboxPersistence {
  load(): OutboxEntry[];
  save(entries: OutboxEntry[]): void;
}

/** Result of attempting one item's write. */
export interface SendResult {
  ok: boolean;
  /** True when the server rejected the write for good (not a transient network
   * error) — e.g. a version conflict or lost visibility. The entry is dropped
   * and the caller re-reconciles. */
  permanent?: boolean;
  /** The row's new server `version` after a successful write, so the outbox can
   * base the item's next queued write on it. */
  version?: number;
}

// Transient-retry backoff bounds. A transient failure while still "online"
// (request reached the network but failed) must back off rather than re-flush
// immediately — an unconditional re-flush spins the CPU and hammers the server.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

// Longest a no-base write is HELD waiting for an in-flight hydration to resolve
// its concurrency base before falling back to an unchecked send. A hydration
// that merely fails (offline / the 8s supabaseFetch read cap) settles on its
// own and releases the hold via noteHydrationSettled, so this only bites the
// pathological case the hold can't otherwise escape: a hydrate that NEVER
// settles (e.g. a service-worker NetworkOnly read whose abort doesn't surface),
// which would otherwise strand the write — and the optimistic UI — forever.
// Sits past the 8s read cap so a normally-failing hydrate gets to resolve a
// real base first; only a truly-stuck one trips this.
const HOLD_MAX_MS = 20_000;

export class ItemStateOutbox {
  // Pending merged changes per item, in insertion order (Map preserves it).
  private readonly queue = new Map<ItemId, ChangedFields>();
  // Entries whose send() is awaiting a response: removed from `queue` so a
  // concurrent enqueue re-adds cleanly, but still reported as pending so a
  // hydrate racing the in-flight write doesn't treat the optimistic local row as
  // synced and wipe/overwrite it.
  private readonly inFlight = new Map<ItemId, ChangedFields>();
  private draining = false;
  // Set when a fresh enqueue arrives mid-drain — distinct from an item left
  // queued by a transient failure, so re-entrant work re-flushes at once while
  // a failing write backs off instead of busy-looping.
  private dirtyDuringDrain = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  // The server version each pending item's queued change is based on (sent to
  // the server for the optimistic-concurrency check). Snapshotted when an item
  // first goes pending; advanced to the server's returned version after a
  // successful write so sequential edits don't false-conflict.
  private readonly base = new Map<ItemId, number>();
  // Last known server version per item, from hydrate observation and successful
  // sends — the base a *fresh* (not-yet-pending) edit will be based on.
  private readonly serverVersion = new Map<ItemId, number>();
  // Whether a full server hydrate has been observed. Until then we can't tell an
  // item with no known version apart from a genuinely-new one, so we send a null
  // base (no check) rather than assume 0 ("expect no row") and false-conflict an
  // edit made on an already-existing item during a cold boot.
  private hydrated = false;
  // How many item_state hydrations are currently in flight (the data source
  // brackets each read with noteHydrationStarted/Settled). When > 0, a write
  // whose concurrency base can't be determined yet is HELD rather than sent with
  // no base check: the in-flight hydrate is about to resolve the base (the row's
  // version, or its absence → base 0), so sending unchecked now could clobber a
  // concurrent cross-device change to a row we haven't learned about. With no
  // hydrate in flight to wait on (e.g. an offline edit on a brand-new item), the
  // write still goes out unchecked as before — see resolveBase.
  private hydrationsInFlight = 0;
  // Bounded fallback for the hold: a one-shot timer armed while a no-base write
  // is being held, and the flag it sets. If a hydrate never settles (so
  // noteHydrationSettled never fires and hydrationsInFlight stays positive), the
  // timer flips `holdReleased` true so resolveBase stops holding and the write
  // goes out unchecked rather than being stranded forever. Reset once a hydrate
  // settles, so a later stall gets its own bounded wait.
  private holdReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private holdReleased = false;

  constructor(
    /** Persist `changed` for one item (carrying the base version for the
     * optimistic-concurrency check); resolves with delivery outcome. */
    private readonly send: (
      id: ItemId,
      changed: ChangedFields,
      baseVersion: number | null,
    ) => Promise<SendResult>,
    private readonly persistence: OutboxPersistence,
    /** Online check — flush is a no-op while offline. */
    private readonly isOnline: () => boolean,
    /** Invoked with the ids whose writes were permanently rejected, so the
     * caller can re-pull server truth to correct the optimistic local state. */
    private readonly onPermanentReject: (ids: ItemId[]) => void,
    /** Invoked after a drain in which at least one write committed server-side,
     * so the caller can re-validate server-derived reads (e.g. the per-feed
     * unread-count query) that were optimistically refetched before the write
     * landed. Optional — the mock source has no outbox. */
    private readonly onDrained?: () => void,
  ) {
    for (const e of this.persistence.load()) {
      this.queue.set(e.id, e.changed);
      if (e.base != null) this.base.set(e.id, e.base);
    }
  }

  /** Record server versions observed by a hydrate so a future (not-yet-pending)
   * edit is based on the right version. Skips items with a pending write — their
   * base is locked to what the edit was made against, and a successful send (or
   * a conflict reconcile) is the authority for advancing it. */
  observeServerVersions(rows: Iterable<readonly [ItemId, number]>): void {
    this.hydrated = true;
    for (const [id, version] of rows) {
      // Skip an item with a LOCKED base — its base is pinned to the version the
      // edit was made against, and a successful send (or a conflict reconcile) is
      // the authority for advancing it. But a queued/in-flight write with NO
      // locked base (one that was HELD because its base couldn't be determined
      // before this hydrate) DOES want this version, so its now-unblocked send
      // uses the right base instead of falsely assuming absence (base 0) and
      // dropping a legitimate edit as a phantom conflict.
      if (this.base.has(id)) continue;
      // Monotonic: the server `version` only ever increases, so a lower observed
      // value is a stale read (e.g. a select that began before an in-flight write
      // committed and returned after). Ignoring it stops a stale hydrate from
      // rewinding a version a successful send just recorded — which would make
      // the next edit base on an old version and false-conflict.
      const known = this.serverVersion.get(id);
      if (known == null || version >= known) this.serverVersion.set(id, version);
    }
  }

  /** Seed last-known server versions from the persisted local store at boot, so
   * an edit made before the first live hydrate (e.g. while offline, when the
   * NetworkOnly item_state read fails) still bases on a known version rather
   * than a blind no-check write. Same monotonic merge as observeServerVersions
   * but does NOT mark "hydrated": only a real server read confirms an item is
   * absent, which is what authorizes base 0 for a brand-new edit. */
  seedConfirmedVersions(rows: Iterable<readonly [ItemId, number]>): void {
    for (const [id, version] of rows) {
      if (this.queue.has(id) || this.inFlight.has(id)) continue;
      const known = this.serverVersion.get(id);
      if (known == null || version >= known) this.serverVersion.set(id, version);
    }
  }

  /** The data source calls this when it begins an item_state hydration, so the
   * outbox knows a base-resolving read is coming and can HOLD an unresolvable-base
   * write rather than send it unchecked (see hydrationsInFlight / resolveBase). */
  noteHydrationStarted(): void {
    this.hydrationsInFlight += 1;
  }

  /** Counterpart to noteHydrationStarted — call when the hydration settles
   * (success OR failure). A settled hydrate has either recorded the held writes'
   * versions (success) or removed the reason to keep waiting (failure leaves no
   * read in flight), so re-flush to deliver anything that was held. */
  noteHydrationSettled(): void {
    if (this.hydrationsInFlight > 0) this.hydrationsInFlight -= 1;
    // The hold's reason is (at least partly) gone — a settled hydrate either
    // resolved held bases (success) or left no read in flight (failure). Once
    // none are in flight, clear the bounded-fallback so a future stall waits
    // afresh rather than sending unchecked off a stale release.
    if (this.hydrationsInFlight === 0) {
      this.holdReleased = false;
      if (this.holdReleaseTimer != null) {
        clearTimeout(this.holdReleaseTimer);
        this.holdReleaseTimer = null;
      }
    }
    // Re-flush so writes held for a base now go out. If a drain is in progress,
    // mark it so the current drain re-runs at its end rather than racing it.
    if (this.draining) this.dirtyDuringDrain = true;
    else void this.flush();
  }

  /** Arm the one-shot bounded-hold fallback (idempotent): if a held write isn't
   * released by a settling hydrate within HOLD_MAX_MS, send it unchecked rather
   * than strand it on a hydrate that never settles. */
  private armHoldRelease(): void {
    if (this.holdReleaseTimer != null || this.holdReleased) return;
    this.holdReleaseTimer = setTimeout(() => {
      this.holdReleaseTimer = null;
      this.holdReleased = true;
      void this.flush();
    }, HOLD_MAX_MS);
    this.holdReleaseTimer.unref?.();
  }

  /** The optimistic-concurrency base to send a write on, or `undefined` to HOLD
   * the write until a base can be determined:
   *  - a base locked when the item first went pending (the version the edit was
   *    made against), else
   *  - the last-known server version (observed by a hydrate or a prior send), else
   *  - 0 ("expect no row") once a live hydrate has CONFIRMED the item is absent
   *    server-side, else
   *  - `undefined` (HOLD) while a hydrate is in flight that's about to resolve one
   *    of the above — sending unchecked now could clobber a concurrent change to a
   *    row we haven't learned about, and the held write retries when it settles —
   *    UNLESS the bounded fallback has fired (`holdReleased`), meaning the hydrate
   *    never settled and we'd otherwise hold forever, else
   *  - `null` (send with NO check) when there's no hydrate to wait on — an offline
   *    edit on a brand-new item replays on reconnect, same as before. */
  private resolveBase(id: ItemId): number | null | undefined {
    const locked = this.base.get(id);
    if (locked !== undefined) return locked;
    const known = this.serverVersion.get(id);
    if (known !== undefined) return known;
    if (this.hydrated) return 0;
    if (this.hydrationsInFlight > 0 && !this.holdReleased) return undefined;
    return null;
  }

  /** Merged un-synced changed-fields per item — both queued and in-flight
   * writes — so hydrate can overlay exactly the pending fields onto server
   * truth. Queued (newer) values win per field over an in-flight send. */
  pendingChanges(): Map<ItemId, ChangedFields> {
    const out = new Map<ItemId, ChangedFields>();
    for (const [id, changed] of this.inFlight) out.set(id, { ...changed });
    for (const [id, changed] of this.queue) {
      out.set(id, { ...out.get(id), ...changed });
    }
    return out;
  }

  /** Ids with an un-synced pending write (queued or in flight). */
  pendingIds(): ItemId[] {
    return [...this.pendingChanges().keys()];
  }

  /** Queue a mutation (merging into any pending entry for the item) and kick a
   * flush. The local store has already applied it optimistically. */
  enqueue(id: ItemId, changed: ChangedFields): void {
    // First un-synced edit for this item: lock its base. Use the known server
    // version if we have one; else 0 ("expect no row") only once a full hydrate
    // has confirmed the item has no server row — before that, leave the base
    // unset so the send goes out with a null base (no check) rather than
    // false-conflict an existing item on a cold boot. Coalesced follow-ups keep
    // whatever base the first edit locked.
    if (!this.queue.has(id) && !this.inFlight.has(id) && !this.base.has(id)) {
      const known = this.serverVersion.get(id);
      if (known != null) this.base.set(id, known);
      else if (this.hydrated) this.base.set(id, 0);
    }
    this.queue.set(id, { ...this.queue.get(id), ...changed });
    if (this.draining) this.dirtyDuringDrain = true;
    this.persist();
    void this.flush();
  }

  /** Attempt to deliver everything queued. Safe to call repeatedly (e.g. on the
   * `online` event and at boot); a single drain runs at a time. */
  async flush(): Promise<void> {
    if (this.draining || !this.isOnline()) return;
    this.draining = true;
    this.dirtyDuringDrain = false;
    const rejected: ItemId[] = [];
    let transient = false;
    let delivered = false;
    try {
      for (const id of [...this.queue.keys()]) {
        const changed = this.queue.get(id);
        if (!changed) continue;
        const baseVersion = this.resolveBase(id);
        // HOLD a write whose concurrency base can't be determined yet (a hydrate
        // is in flight that will resolve it). Leave it queued; noteHydrationSettled
        // re-flushes it once the hydrate lands. This is what stops a write made
        // on a brand-new row exposed before hydration completed from going out
        // with no base check and clobbering a concurrent cross-device change.
        if (baseVersion === undefined) {
          // Bound the hold: if the hydrate never settles, release it eventually
          // rather than strand the write (and the optimistic UI) forever.
          this.armHoldRelease();
          continue;
        }
        // Lock the resolved base for a held write (one enqueued with no base,
        // resolved here from the hydrate's observed version or confirmed
        // absence → 0) so it sticks to the version the user actually acted on.
        // Without this, a transient send failure requeues the entry unlocked, and
        // a later focus/visibility hydrate observing another device's newer
        // version would let the retry rebase onto it (observeServerVersions skips
        // only LOCKED bases) and overwrite that change instead of conflicting.
        // No-op for an already-locked entry; null (no-check) can't be locked.
        if (baseVersion !== null && !this.base.has(id)) {
          this.base.set(id, baseVersion);
          // Persist the resolved base NOW, before the send. The flush's `finally`
          // persist runs only after `send()` resolves, so without this a tab that
          // closes/crashes while the RPC is in flight would leave the entry at
          // base:null on disk — the next boot would re-hold it for a fresh
          // hydrate and could rebase it onto a version another device wrote after
          // the user's action, overwriting instead of conflict/reconcile.
          this.persist();
        }
        // Take the entry before sending. A concurrent enqueue during the await
        // re-adds the item with the newer fields, so coalescing never loses the
        // latest action (and we never clear a field that changed mid-flight). The
        // entry stays visible via `inFlight` so it's still reported as pending
        // until the send resolves.
        this.queue.delete(id);
        this.inFlight.set(id, changed);
        let result: SendResult;
        try {
          result = await this.send(id, changed, baseVersion);
        } catch {
          result = { ok: false, permanent: false }; // network error → transient
        } finally {
          this.inFlight.delete(id);
        }
        if (!result.ok && !result.permanent) {
          // Transient: requeue, letting any newer enqueue (arrived during send)
          // win per field. Base is unchanged — the write never landed.
          transient = true;
          const newer = this.queue.get(id);
          this.queue.set(id, newer ? { ...changed, ...newer } : changed);
        } else if (result.permanent) {
          // Conflict / lost visibility: roll back. Drop this item entirely —
          // including any newer edits queued during the send, which were based
          // on the now-reconciled-away optimistic state — and re-reconcile.
          this.queue.delete(id);
          this.base.delete(id);
          rejected.push(id);
        } else {
          // Success. Advance the known server version; base the item's next
          // queued edit (if any arrived during the send) on it, else clear it.
          delivered = true;
          if (result.version != null) this.serverVersion.set(id, result.version);
          if (this.queue.has(id) && result.version != null) {
            this.base.set(id, result.version);
          } else {
            this.base.delete(id);
          }
        }
        if (!this.isOnline()) break; // went offline mid-drain; keep the rest
      }
    } finally {
      this.draining = false;
      this.persist();
    }
    if (rejected.length > 0) this.onPermanentReject(rejected);
    // A write committed → let server-derived reads (the unread-count query)
    // re-validate now that the server reflects it.
    if (delivered) this.onDrained?.();

    if (!this.isOnline()) return; // reconnect ('online' event) will re-flush
    if (this.dirtyDuringDrain) {
      // Genuine new work arrived mid-drain — process it on the next microtask.
      this.retryAttempt = 0;
      this.clearRetry();
      void Promise.resolve().then(() => this.flush());
    } else if (transient && this.queue.size > 0) {
      // A write failed transiently; back off rather than spin. (A reconnect
      // also re-flushes via the 'online' listener.)
      this.scheduleRetry();
    } else {
      // Clean drain — reset backoff.
      this.retryAttempt = 0;
      this.clearRetry();
    }
  }

  /** Arm a single backed-off retry after a transient failure. */
  private scheduleRetry(): void {
    if (this.retryTimer != null) return; // one pending retry at a time
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempt, RETRY_MAX_MS);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
    // Don't keep the process/tab alive purely for a retry.
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer != null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private persist(): void {
    // Persist the union of in-flight and queued changes (same merge as
    // pendingChanges). A persist triggered by a follow-up enqueue must NOT drop
    // an in-flight predecessor that's been taken out of `queue` for its send —
    // otherwise a crash/reload before that RPC confirms would never replay it.
    const merged = new Map<ItemId, ChangedFields>();
    for (const [id, changed] of this.inFlight) merged.set(id, { ...changed });
    for (const [id, changed] of this.queue) {
      merged.set(id, { ...merged.get(id), ...changed });
    }
    this.persistence.save(
      [...merged.entries()].map(([id, changed]) => ({
        id,
        changed,
        base: this.base.get(id) ?? null,
      })),
    );
  }
}

/** localStorage-backed outbox persistence (degrades to in-memory on failure). */
export function localStorageOutboxPersistence(key: string): OutboxPersistence {
  const hasWindow = typeof window !== 'undefined';
  return {
    load() {
      if (!hasWindow) return [];
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
      } catch {
        return [];
      }
    },
    save(entries) {
      if (!hasWindow) return;
      try {
        if (entries.length === 0) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify(entries));
      } catch {
        // quota / privacy-mode: degrade to in-memory
      }
    },
  };
}
