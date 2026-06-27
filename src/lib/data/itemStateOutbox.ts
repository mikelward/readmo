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
//    while a *permanent* server rejection (lost visibility) drops it and asks the
//    caller to re-reconcile from server truth.
//
// Conflict resolution is per-field LAST-WRITE-WINS (SPEC.md *Sync → Conflict
// resolution*): each changed field carries the wall-clock time of the action
// that set it (`at`). `set_item_state` keeps, per field, whichever write has the
// newer `at`, so two devices touching independent fields never conflict and a
// stale offline replay loses to a newer change instead of clobbering it — no
// version numbers, base tracking, or conflict/hold machinery. Because the client
// always sends an exclusivity-closed diff (a Pin diff carries the cleared
// Done/Hidden, all stamped with the same `at`), per-field LWW lands on a
// consistent state without server-side re-derivation.
//
// `pendingIds()` lets the hydrate path preserve un-synced local rows while
// clearing genuinely-stale ones (closing the "clear local states absent from
// hydration" gap without a data-loss race).

/** The boolean changed-field diff that the store emits and the hydrate path
 * overlays. The outbox stamps each field with its action time internally. */
export type ChangedFields = Partial<Record<ItemStateField, boolean>>;

/** A changed field plus the wall-clock time it changed — the per-field
 * last-write-wins clock the server compares. */
interface StampedChange {
  value: boolean;
  at: number;
}

/** Per-item merged changed fields with their action timestamps. */
type StampedFields = Partial<Record<ItemStateField, StampedChange>>;

interface OutboxEntry {
  id: ItemId;
  changed: StampedFields;
}

export interface OutboxPersistence {
  load(): OutboxEntry[];
  save(entries: OutboxEntry[]): void;
}

/** Result of attempting one item's write. */
export interface SendResult {
  ok: boolean;
  /** True when the server rejected the write for good (not a transient network
   * error) — i.e. the caller lost visibility of the item (42501). The entry is
   * dropped and the caller re-reconciles. */
  permanent?: boolean;
}

// Transient-retry backoff bounds. A transient failure while still "online"
// (request reached the network but failed) must back off rather than re-flush
// immediately — an unconditional re-flush spins the CPU and hammers the server.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/** Merge `next` over `base` per field — `next` wins because its action time is
 * the same or newer (enqueues arrive in wall-clock order). */
function mergeStamped(base: StampedFields, next: StampedFields): StampedFields {
  return { ...base, ...next };
}

export class ItemStateOutbox {
  // Pending merged changes per item, in insertion order (Map preserves it).
  private readonly queue = new Map<ItemId, StampedFields>();
  // Entries whose send() is awaiting a response: removed from `queue` so a
  // concurrent enqueue re-adds cleanly, but still reported as pending so a
  // hydrate racing the in-flight write doesn't treat the optimistic local row as
  // synced and wipe/overwrite it.
  private readonly inFlight = new Map<ItemId, StampedFields>();
  private draining = false;
  // Set when a fresh enqueue arrives mid-drain — distinct from an item left
  // queued by a transient failure, so re-entrant work re-flushes at once while
  // a failing write backs off instead of busy-looping.
  private dirtyDuringDrain = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;

  constructor(
    /** Persist one item's changed fields (each carrying its action time for the
     * per-field last-write-wins merge); resolves with the delivery outcome. */
    private readonly send: (
      id: ItemId,
      changed: StampedFields,
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
    for (const e of this.persistence.load()) this.queue.set(e.id, e.changed);
  }

  /** Merged un-synced changed-fields per item — both queued and in-flight
   * writes — so hydrate can overlay exactly the pending fields onto server
   * truth. Queued (newer) values win per field over an in-flight send. */
  pendingChanges(): Map<ItemId, ChangedFields> {
    const out = new Map<ItemId, ChangedFields>();
    const merge = (src: Map<ItemId, StampedFields>) => {
      for (const [id, changed] of src) {
        const cur = out.get(id) ?? {};
        for (const [f, c] of Object.entries(changed) as [
          ItemStateField,
          StampedChange,
        ][]) {
          cur[f] = c.value;
        }
        out.set(id, cur);
      }
    };
    merge(this.inFlight);
    merge(this.queue);
    return out;
  }

  /** Ids with an un-synced pending write (queued or in flight). */
  pendingIds(): ItemId[] {
    return [...this.pendingChanges().keys()];
  }

  /** Queue a mutation (merging into any pending entry for the item) and kick a
   * flush. `at` is the action's wall-clock time — the per-field last-write-wins
   * clock. The local store has already applied it optimistically. */
  enqueue(id: ItemId, changed: ChangedFields, at: number): void {
    const cur = this.queue.get(id) ?? {};
    for (const [f, v] of Object.entries(changed) as [ItemStateField, boolean][]) {
      cur[f] = { value: v, at };
    }
    this.queue.set(id, cur);
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
        // Take the entry before sending. A concurrent enqueue during the await
        // re-adds the item with the newer fields, so coalescing never loses the
        // latest action. The entry stays visible via `inFlight` so it's still
        // reported as pending until the send resolves.
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
          // win per field. The write never landed.
          transient = true;
          const newer = this.queue.get(id);
          this.queue.set(id, newer ? mergeStamped(changed, newer) : changed);
        } else if (result.permanent) {
          // Lost visibility: roll back. Drop this item entirely — including any
          // newer edits queued during the send — and re-reconcile.
          this.queue.delete(id);
          rejected.push(id);
        } else {
          delivered = true;
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
    const merged = new Map<ItemId, StampedFields>();
    for (const [id, changed] of this.inFlight) merged.set(id, { ...changed });
    for (const [id, changed] of this.queue) {
      merged.set(id, mergeStamped(merged.get(id) ?? {}, changed));
    }
    this.persistence.save(
      [...merged.entries()].map(([id, changed]) => ({ id, changed })),
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
