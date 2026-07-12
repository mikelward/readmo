// Tracks list items the user tapped to hand off to newshacker (the per-feed
// "open on newshacker" mode), so the card can show a "syncing" spinner until the
// next reverse pull resolves whether it was marked Done over there (SPEC.md
// *Mirror dismissals and pins to newshacker* → reverse pull). On resolution the
// card either grays/strikes in place (done) or settles to the opened fade.
//
// Persisted to **sessionStorage**, NOT a module-level set like
// newshackerMirrorSuppress: opening on newshacker is a same-tab, cross-origin
// navigation (readmo.app → newshacker.app), so Readmo's page unloads and reloads
// on Back. A module singleton would be wiped on the round-trip; sessionStorage is
// per-origin and survives it, so the pending marker written before navigating is
// still there when the reader returns. A max-age failsafe drops a marker whose
// pull never resolved it (e.g. the reader never came back online), so a spinner
// can't spin forever.
//
// The stored value is only an item id (a UUID) + a timestamp — no content — so a
// stale marker left after an account switch on a shared device can't leak
// anything: a different user's client simply has no row with that id, so no
// spinner shows, and the next reverse pull clears the set regardless.

import type { ItemId } from './types';

const KEY = 'readmo:newshacker-reverse-pending';
// Failsafe: a pending marker older than this is treated as resolved (dropped),
// so a handoff whose pull never lands doesn't strand a spinner. Generous — a
// normal round-trip resolves on the very next app open / focus / pull.
const MAX_AGE_MS = 30 * 60 * 1000;

let mem: Map<ItemId, number> | null = null;
const listeners = new Set<() => void>();

function readStorage(): Map<ItemId, number> {
  const map = new Map<ItemId, number>();
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Array<{ id: unknown; at: unknown }>;
    if (!Array.isArray(parsed)) return map;
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const e of parsed) {
      if (
        e &&
        typeof e.id === 'string' &&
        typeof e.at === 'number' &&
        e.at >= cutoff
      ) {
        map.set(e.id, e.at);
      }
    }
  } catch {
    // Corrupt JSON or unavailable storage → treat as empty.
  }
  return map;
}

function load(): Map<ItemId, number> {
  if (!mem) mem = readStorage();
  return mem;
}

function persist(): void {
  try {
    const arr = [...load()].map(([id, at]) => ({ id, at }));
    sessionStorage.setItem(KEY, JSON.stringify(arr));
  } catch {
    // Storage full/unavailable — the in-memory mirror still works this session.
  }
}

function emit(): void {
  for (const l of listeners) l();
}

/** Mark the item as awaiting reverse-sync resolution — call right before the
 * open-on-newshacker handoff navigation. Idempotent per id (refreshes its
 * timestamp). */
export function markReverseSyncPending(id: ItemId): void {
  load().set(id, Date.now());
  persist();
  emit();
}

/** Whether this item is still awaiting a reverse-sync resolution. Drops (and
 * reports false for) a marker past the max-age failsafe. */
export function isReverseSyncPending(id: ItemId): boolean {
  const at = load().get(id);
  if (at === undefined) return false;
  if (at < Date.now() - MAX_AGE_MS) {
    load().delete(id);
    persist();
    emit();
    return false;
  }
  return true;
}

/** Clear every pending marker — call once a reverse pull completes, since one
 * pull reconciles the full newshacker Done/Pinned state, so every pending id's
 * outcome (done → grayed in place, else the opened fade) is now known. No-op
 * when empty. */
export function clearAllReverseSyncPending(): void {
  const map = load();
  if (map.size === 0) return;
  map.clear();
  persist();
  emit();
}

/** Subscribe to pending-set changes (for `useSyncExternalStore`). */
export function subscribeReverseSyncPending(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test-only: reset the in-memory mirror so a fresh sessionStorage read happens. */
export function _resetReverseSyncPendingForTests(): void {
  mem = null;
}
