import type { FeedId, ItemId, ItemState } from './types';

/** A minimal view of a loaded row — id + which feed it belongs to. */
interface RawRow {
  item: { id: ItemId; feedId: FeedId };
}

/** A fetch-start reflection snapshot (see {@link UnreadDecrementLedger.drainedIds}):
 * the entries whose drained writes the fetch's response will provably reflect,
 * tagged with the producing ledger's instance token. Stored inside the count
 * query's (cached, persisted) data, so it must stay JSON-serializable. */
export interface ReflectedSnapshot {
  ledger: string;
  entries: Array<{ id: ItemId; gen: number }>;
}

/**
 * Exact per-feed unread badges from the server's unread ID membership plus the
 * current local state — the `feed_unread_ids` path that supersedes the count +
 * {@link UnreadDecrementLedger} approximation when the backend supports it.
 *
 * A bare *count* can't reveal whether it already reflects a given local write,
 * so the ledger has to guess the sync lag and lives with documented edge cases.
 * With the unread ID *set* in hand there's no guessing: re-derive each feed's
 * badge from what's true right now.
 *
 *  - **Keep** a server-unread id only while local state still agrees it's
 *    unread — drop it the moment local triage marks it Done, active Hidden, or
 *    Opened-and-not-pinned. This is exact (membership is known), so there's no
 *    double-subtract and no round-trip lag: a just-swept row leaves the badge
 *    immediately and stays gone, whether or not the server response predates the
 *    write.
 *  - **Add** a loaded row that is locally **pinned** and unread (and not
 *    Done/Hidden) even when the server set doesn't list it yet — a fresh pin
 *    always makes the item listable (the pin branch) AND to-do, so it's counted
 *    at once. The `Set` dedups against ids the server already returned. Only
 *    pins are added, and deliberately so: additions are *only* ever needed for
 *    items outside the freshness window (an in-window unread item is already in
 *    the server set), which are listable solely via the floor or a pin — and the
 *    client can verify a pin but not floor membership. Trusting any other
 *    locally-unread loaded row would resurrect STALE ones the server has
 *    legitimately dropped (an old item that was listable only via a since-removed
 *    pin, its row lingering in the cache), reading the badge high. The one cost
 *    is that a NON-pinned row Undone/marked-unread shows the badge one low for
 *    the sync round-trip until the server set reflects the restore — a transient,
 *    self-healing undercount identical to the ledger's, and the exact path's win
 *    is on dismissals (the common case), which it counts down precisely.
 *  - **Provisionally remove** a row buffered for auto-hide-on-scroll: it has
 *    scrolled off the top but its dismissal write is deferred until the viewport
 *    settles, so it's still in the set — discount it now (a pinned row is
 *    shielded from the flush and stays).
 *
 * Pure and stateless (unlike the ledger): every render recomputes from the
 * current inputs, which is why it needs no generation/instance bookkeeping.
 */
export function adjustUnreadIds(
  serverIds: Readonly<Record<FeedId, readonly ItemId[]>>,
  feedIds: readonly FeedId[],
  loadedRows: readonly RawRow[],
  getState: (id: ItemId) => ItemState,
  bufferedExitTop: ReadonlySet<ItemId>,
): Record<FeedId, number> {
  const wanted = new Set(feedIds);
  const sets = new Map<FeedId, Set<ItemId>>();
  for (const f of feedIds) sets.set(f, new Set());
  const isUnread = (st: ItemState) =>
    !st.done && !st.hidden && (st.pinned || !st.opened);

  // Server membership, filtered by current local state.
  for (const f of feedIds) {
    const set = sets.get(f)!;
    for (const id of serverIds[f] ?? []) {
      if (isUnread(getState(id))) set.add(id);
    }
  }
  // Reconcile against the loaded rows: provisionally remove a row buffered for
  // auto-hide (dismissal write deferred; a pinned row is shielded from the flush
  // and stays), otherwise add a locally-pinned unread row the server set doesn't
  // list yet (a fresh pin — the only addition the client can make soundly; see
  // the doc). Dedups against the server ids.
  for (const { item } of loadedRows) {
    if (!wanted.has(item.feedId)) continue;
    const set = sets.get(item.feedId)!;
    const st = getState(item.id);
    if (bufferedExitTop.has(item.id) && !st.pinned) set.delete(item.id);
    else if (st.pinned && !st.done && !st.hidden) set.add(item.id);
  }

  const out: Record<FeedId, number> = {};
  for (const [f, set] of sets) out[f] = set.size;
  return out;
}

/** Distinguishes ledger instances created in the same millisecond. */
let ledgerSeq = 0;

/**
 * Holds the per-feed unread/to-do badge steady while local triage syncs.
 *
 * `getFeedUnreadCounts` is a server-only read, so it lags a just-applied write:
 * right after a Sweep, a row Done, or an auto-hide-on-scroll burst, the badge
 * would sit at its pre-triage value while the rows are already gone from the
 * list. The ledger records each such dismissal as a one-per-item decrement the
 * moment its (still-unsynced) write is applied, and — crucially — keeps that
 * decrement until a count response that *provably includes* the write lands.
 *
 * The lifecycle of an entry:
 *
 *  1. **Noted** (`noteDismissals`) while the row's write is still pending in
 *     the outbox and its *current* local state unambiguously means the server
 *     still counts it but the user has triaged it away — now Done or
 *     active-Hidden, **not** pinned, and **not** Opened.
 *  2. **Held** across the outbox drain. Keying the decrement off the pending
 *     set alone (the previous design) bounced the badge on every sync: the
 *     pending id clears at write-confirm, one round-trip before the invalidated
 *     count refetch returns, so the badge jumped back to the stale count and
 *     down again — constant up/down flicker under mark-done-on-scroll. The
 *     ledger instead survives the drain (and the row later dropping out of the
 *     loaded pages on a list refetch).
 *  3. **Retired** (`retire`) when a count response lands whose request started
 *     after the write drained. The count query's `queryFn` snapshots
 *     `drainedIds` at fetch start; the server's answer reflects exactly those
 *     writes, so their decrements retire in the same render the fresh count
 *     paints — never before (no bounce up), never after (no double-subtract).
 *     An entry the user has since restored (Undo) retires immediately instead,
 *     whatever its sync state — the row is back, so the count must be too.
 *
 * Each entry carries a **generation** stamped at note time, and a snapshot
 * only retires an entry whose generation still matches. A snapshot is applied
 * on every render for as long as its response is the current one, and it must
 * stay idempotent across an undo → re-dismiss of the same item in that window
 * (Codex P2 on #442): the re-dismissal notes a NEW entry (new generation),
 * which the stale snapshot — a reflection of the FIRST dismissal only — must
 * not retire, or the badge would overstate until the second write synced.
 *
 * Snapshots also carry the **instance token** of the ledger that produced
 * them, and {@link retire} ignores a snapshot from any other instance (Codex
 * P2 on #442): the count query's cached data — which React Query persists
 * across remounts AND reloads — replays old snapshots at a fresh ledger whose
 * generation counter has restarted, so without the token a recycled `{id,
 * gen}` pair could spuriously match and retire a brand-new entry. The token is
 * time-based, so it can't recur across reloads either.
 *
 * This deliberately reads only the *current* local state, never an inferred
 * server state: the outbox coalesces pending writes to their final value, so a
 * field's pre-sync server value can't be recovered by "flipping" the pending
 * change (pin-then-unpin-before-sync leaves `{pinned:false}` over a server that
 * is already `pinned:false`). The conservative predicate can't over-count as a
 * result; its one cost is that a pinned-then-read row later marked Done (the pin
 * cleared, `opened` still true) keeps lagging until its write syncs and the
 * count refetches — an acceptable, self-healing miss.
 *
 * One accepted residual in the other direction: a fetch that starts while a
 * write is still pending can't claim it in its snapshot, yet the write may
 * commit before the server evaluates the count — the response then already
 * excludes the item while its decrement still applies, reading the badge one
 * low until the drain-triggered refetch retires it a round-trip later. A bare
 * *count* can't reveal whether it includes a given write, so telling those
 * responses apart needs the `feed_unread_ids` ID-list RPC (TODO.md §Server /
 * batch query limits); until then a brief dip is the conservative side to err
 * on — the badge settles from below and never bounces up.
 *
 * For the same reason, a live entry deliberately does NOT retire when its row
 * gains `opened` while still dismissed. A *local* open of a just-dismissed row
 * leaves the server counting it (neither write has drained), so the decrement
 * is still right and dropping it would bounce the badge up; a *cross-device*
 * open arriving by hydrate means the server already stopped counting it, and
 * the decrement dips one low until the post-drain retire. The ledger sees
 * id-level pending state, not per-field sync state, so it can't tell the two
 * apart — it keeps the decrement, again erring toward the brief dip over the
 * bounce.
 *
 * A source with no outbox (the mock) never reports a pending write, so nothing
 * is ever noted and the counts pass through untouched.
 */
export class UnreadDecrementLedger {
  /** Live decrements: dismissed item → the feed whose badge it discounts, plus
   * the generation stamped when the entry was noted (see the class doc). */
  private readonly entries = new Map<ItemId, { feedId: FeedId; gen: number }>();
  private gen = 0;
  /** Unique per instance and across reloads (time component), so a snapshot
   * replayed from cached/persisted query data can never retire entries of a
   * ledger that didn't produce it. */
  private readonly instance = `${Date.now().toString(36)}-${++ledgerSeq}`;

  /** Record loaded rows freshly triaged out of the unread set (see the class
   * doc for the predicate). Idempotent — an already-noted row is skipped, so
   * re-running on every render can't double-count. */
  noteDismissals(
    rawItems: readonly RawRow[],
    getState: (id: ItemId) => ItemState,
    pending: ReadonlySet<ItemId>,
  ): void {
    if (pending.size === 0) return;
    for (const { item } of rawItems) {
      if (!pending.has(item.id) || this.entries.has(item.id)) continue;
      const st = getState(item.id);
      if ((st.done || st.hidden) && !st.pinned && !st.opened) {
        this.entries.set(item.id, { feedId: item.feedId, gen: ++this.gen });
      }
    }
  }

  /** The noted entries whose write has already drained (left the pending set)
   * at this moment, scoped to `feedIds` — the feeds this count fetch asks
   * about. Call at count-fetch start and hand the result back to
   * {@link retire} when that fetch's response lands: the server answered after
   * these writes committed, so its count reflects them. The feed scope matters
   * (Codex P2 on #442): a response only speaks for the feeds it was asked
   * about, so an entry for an out-of-view feed must keep its decrement — that
   * feed's cached count is still the stale pre-dismissal one. */
  drainedIds(
    pending: ReadonlySet<ItemId>,
    feedIds: ReadonlySet<FeedId>,
  ): ReflectedSnapshot {
    const entries: Array<{ id: ItemId; gen: number }> = [];
    for (const [id, e] of this.entries) {
      if (!pending.has(id) && feedIds.has(e.feedId)) entries.push({ id, gen: e.gen });
    }
    return { ledger: this.instance, entries };
  }

  /** Drop entries the landed count already reflects (`reflected`, from the
   * fetch-start {@link drainedIds} snapshot) plus any the user has since
   * restored — a row that is no longer triaged away (Undo un-did the Done, or
   * a pin resurrected it) must stop discounting its feed right away. Only an
   * entry whose generation still matches the snapshot retires: a same-id entry
   * re-noted since (undo → dismiss again) is a NEW dismissal the response
   * pre-dates, and its decrement must survive. A snapshot produced by a
   * DIFFERENT ledger instance (replayed from cached/persisted query data after
   * a remount or reload) retires nothing — its generations belong to another
   * namespace. Pass null when the current count carries no snapshot; the
   * restored-row pruning still runs. */
  retire(
    reflected: ReflectedSnapshot | null,
    getState: (id: ItemId) => ItemState,
  ): void {
    if (reflected && reflected.ledger === this.instance) {
      for (const { id, gen } of reflected.entries) {
        if (this.entries.get(id)?.gen === gen) this.entries.delete(id);
      }
    }
    for (const id of this.entries.keys()) {
      const st = getState(id);
      if (!((st.done || st.hidden) && !st.pinned)) this.entries.delete(id);
    }
  }

  /** `serverCounts` minus the per-feed tally of live entries, floored at 0.
   * Feeds absent from `serverCounts` are left untouched (their entries keep
   * waiting for a count that includes the feed). Returns the input object
   * unchanged when no entry applies. */
  apply(serverCounts: Record<FeedId, number>): Record<FeedId, number> {
    if (this.entries.size === 0) return serverCounts;
    const decrements = new Map<FeedId, number>();
    for (const { feedId } of this.entries.values()) {
      decrements.set(feedId, (decrements.get(feedId) ?? 0) + 1);
    }
    let touched = false;
    const out: Record<FeedId, number> = { ...serverCounts };
    for (const [feedId, dec] of decrements) {
      if (out[feedId] != null) {
        out[feedId] = Math.max(0, out[feedId] - dec);
        touched = true;
      }
    }
    return touched ? out : serverCounts;
  }
}
