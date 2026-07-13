// Coordinator for the newshacker reverse pull (SPEC.md *Mirror dismissals and
// pins to newshacker* → reverse pull), owning WHEN to pull and when an
// open-on-newshacker "syncing" marker counts as resolved.
//
// The naive rule — clear every pending marker as soon as one pull completes —
// answers the handoff question ("did they mark it Done over there?") from
// whatever state that pull happened to see. On a same-device round trip that's
// a race: newshacker's own flush-on-hide POST (its client → its server) and
// our return-focus pull start at the same instant, and when the pull's read
// beats the flush's write, the marker used to resolve against the NOT-yet-
// synced state and the card settled on a stale answer until the next focus.
//
// This module makes resolution evidence-based instead:
//   * A marker resolves only when its item's pull-visible state (the
//     Done/Pinned/Hidden fields the reverse pull can change) is OBSERVED to
//     change across a pull — the answer arrived. (A concurrent cross-device
//     resync changing the same item also counts: either way the local state
//     is fresher than the handoff, so the card can settle truthfully.)
//   * While markers remain unresolved after a successful pull, the pull is
//     retried on a short ladder (500 ms, then 1000 ms) to outwait newshacker's
//     upload. A ladder that completes with the state still unchanged IS the
//     answer — "nothing changed over there" — so the survivors resolve then.
//   * A FAILED pull (offline, function down) resolves nothing; the markers
//     stay armed for the next trigger (focus/visibility/online/PTR), bounded
//     by the pending store's 30-minute failsafe.
//
// One coordinator run at a time, app-wide: a tab return fires focus AND
// visibilitychange, and the Edge GET isn't deduped server-side, so overlapping
// callers coalesce onto the in-flight run. Callers get a promise for the FIRST
// pull attempt (pull-to-refresh awaits that before refetching); the retry
// ladder continues detached so it never delays the caller.

import type { ItemStateStore } from './data/itemState';
import type { ItemId, ItemState } from './types';
import {
  clearAllReverseSyncPending,
  getReverseSyncPendingIds,
  resolveReverseSyncPending,
} from './newshackerReverseSyncPending';

/** Retry spacing after a successful pull that left markers unresolved. */
export const REVERSE_PULL_RETRY_DELAYS_MS: readonly number[] = [500, 1000];

interface ReversePullSource {
  readonly stateStore: ItemStateStore;
  pullNewshackerState?(): Promise<{
    linked: boolean;
    applied: number;
    ok?: boolean;
  }>;
}

// ONLY the fields the reverse pull can change — done and pinned, plus hidden
// via their exclusivity closures — flattened for cheap before/after
// comparison. `opened` is deliberately excluded (the handoff tap itself
// stamps it — and, on mark-done-on-open feeds, done — at nearly the marker's
// own clock, so clock-based rules would self-resolve instantly), and so is
// `favorite`: the pull never writes favorites, so a cross-device favorite
// landing via a concurrent resync says nothing about the handoff question
// and must not settle the card.
function fingerprint(s: ItemState): string {
  return [
    s.done,
    s.doneAt,
    s.pinned,
    s.pinnedAt,
    s.hidden,
    s.hiddenAt,
  ].join('|');
}

let inFlight: Promise<void> | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One pull plus evidence-based marker resolution. Returns whether the pull
 * actually consulted newshacker (only such pulls advance the ladder toward
 * the terminal "no change" resolution). */
async function pullOnce(ds: ReversePullSource): Promise<boolean> {
  const pending = getReverseSyncPendingIds();
  const before = new Map<ItemId, string>(
    pending.map((id) => [id, fingerprint(ds.stateStore.get(id))]),
  );
  let consulted = false;
  try {
    const res = await ds.pullNewshackerState!();
    // The live source never throws — it maps every transport/backend failure
    // (offline, function not deployed, signed out) to { linked: false }. And
    // linked:true alone isn't proof either: the Edge Function soft-fails its
    // OWN outbound fetch of newshacker (or the apply RPC) to a 200 with
    // linked:true, applied:0, reporting the distinction in `ok`. So the pull
    // counts as consulted only when linked:true AND ok isn't false — anything
    // less must not advance the ladder, or an outage would end in resolving
    // the markers as "no change" for pulls that never saw newshacker. An
    // older, not-yet-redeployed backend sends no `ok` at all; that undefined
    // is treated as consulted (pre-flag behavior, guardrail #11).
    consulted = res?.linked === true && res?.ok !== false;
  } catch {
    consulted = false;
  }
  // Evidence beats transport: a marker whose item state changed resolves even
  // when THIS pull failed — a concurrent item-state resync may have delivered
  // the answer, and either way the local state is now fresher than the
  // handoff, so the card can settle truthfully.
  for (const [id, fp] of before) {
    if (fingerprint(ds.stateStore.get(id)) !== fp) {
      resolveReverseSyncPending(id);
    }
  }
  return consulted;
}

async function runLadder(ds: ReversePullSource, firstDone: () => void): Promise<void> {
  try {
    const ok = await pullOnce(ds);
    firstDone();
    if (!ok) return;
    for (const retryDelay of REVERSE_PULL_RETRY_DELAYS_MS) {
      if (getReverseSyncPendingIds().length === 0) return;
      await delay(retryDelay);
      // The tab may have been backgrounded mid-ladder (another handoff!);
      // leave the markers for the next visible trigger rather than pulling
      // from a frozen page.
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      if (getReverseSyncPendingIds().length === 0) return;
      if (!(await pullOnce(ds))) return;
    }
    // Ladder exhausted with every pull succeeding and some markers still
    // unresolved: newshacker answered, repeatedly, that nothing changed for
    // those items. That IS the resolution — settle the cards.
    if (getReverseSyncPendingIds().length > 0) clearAllReverseSyncPending();
  } finally {
    firstDone(); // idempotent; guards the caller against an unexpected throw
    inFlight = null;
  }
}

/**
 * Trigger a reverse pull. Coalesces onto any in-flight run. The returned
 * promise settles when the FIRST pull attempt of the (possibly already
 * running) run completes — not when the retry ladder finishes — so a
 * pull-to-refresh can await "one pull happened" without inheriting up to
 * 1.5 s of retries. Never rejects (the pull is best-effort throughout).
 */
export function requestReversePull(ds: ReversePullSource): Promise<void> {
  if (!ds.pullNewshackerState) return Promise.resolve();
  if (inFlight) return inFlight;
  let firstDone!: () => void;
  const first = new Promise<void>((resolve) => {
    firstDone = resolve;
  });
  inFlight = first;
  void runLadder(ds, firstDone);
  return first;
}

/** Test-only: forget an in-flight run so the next request starts fresh. */
export function _resetReversePullForTests(): void {
  inFlight = null;
}
