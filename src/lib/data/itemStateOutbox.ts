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
//    while a *permanent* server rejection (e.g. lost visibility) drops it and asks
//    the caller to re-reconcile from server truth.
//
// `pendingIds()` lets the hydrate path preserve un-synced local rows while
// clearing genuinely-stale ones (closing the "clear local states absent from
// hydration" gap without a data-loss race).

export type ChangedFields = Partial<Record<ItemStateField, boolean>>;

interface OutboxEntry {
  id: ItemId;
  changed: ChangedFields;
}

export interface OutboxPersistence {
  load(): OutboxEntry[];
  save(entries: OutboxEntry[]): void;
}

/** Result of attempting one item's write. */
export interface SendResult {
  ok: boolean;
  /** True when the server rejected the write for good (not a transient network
   * error) — the entry is dropped and the caller re-reconciles. */
  permanent?: boolean;
}

// Transient-retry backoff bounds. A transient failure while still "online"
// (request reached the network but failed) must back off rather than re-flush
// immediately — an unconditional re-flush spins the CPU and hammers the server.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

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

  constructor(
    /** Persist `changed` for one item; resolves with delivery outcome. */
    private readonly send: (id: ItemId, changed: ChangedFields) => Promise<SendResult>,
    private readonly persistence: OutboxPersistence,
    /** Online check — flush is a no-op while offline. */
    private readonly isOnline: () => boolean,
    /** Invoked with the ids whose writes were permanently rejected, so the
     * caller can re-pull server truth to correct the optimistic local state. */
    private readonly onPermanentReject: (ids: ItemId[]) => void,
  ) {
    for (const e of this.persistence.load()) this.queue.set(e.id, e.changed);
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
    try {
      for (const id of [...this.queue.keys()]) {
        const changed = this.queue.get(id);
        if (!changed) continue;
        // Take the entry before sending. A concurrent enqueue during the await
        // re-adds the item with the newer fields, so coalescing never loses the
        // latest action (and we never clear a field that changed mid-flight). The
        // entry stays visible via `inFlight` so it's still reported as pending
        // until the send resolves.
        this.queue.delete(id);
        this.inFlight.set(id, changed);
        let result: SendResult;
        try {
          result = await this.send(id, changed);
        } catch {
          result = { ok: false, permanent: false }; // network error → transient
        } finally {
          this.inFlight.delete(id);
        }
        if (!result.ok && !result.permanent) {
          // Transient: requeue, letting any newer enqueue (arrived during send)
          // win per field.
          transient = true;
          const newer = this.queue.get(id);
          this.queue.set(id, newer ? { ...changed, ...newer } : changed);
        } else if (result.permanent) {
          rejected.push(id);
        }
        if (!this.isOnline()) break; // went offline mid-drain; keep the rest
      }
    } finally {
      this.draining = false;
      this.persist();
    }
    if (rejected.length > 0) this.onPermanentReject(rejected);

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
    this.persistence.save(
      [...this.queue.entries()].map(([id, changed]) => ({ id, changed })),
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
