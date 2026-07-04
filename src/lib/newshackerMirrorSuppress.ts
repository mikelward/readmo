// One-shot suppression of a single Done→newshacker mirror.
//
// Opening a Hacker News item *on newshacker* (the per-feed "open on newshacker"
// mode) with "mark done when opening" marks the item Done in Readmo and
// same-tab-navigates to newshacker to read that very thread. That Done is a
// handoff, NOT a dismissal — mirroring it would sweep the item to Done on
// newshacker at the exact moment you arrive to engage with it. So the row's
// open handler registers the item id here right before setting Done, and the
// mirror hook (`useNewshackerSync`) consumes it and skips that one send.
//
// Deliberately a tiny module-level set, not React state: the producer (ItemRow's
// click handler) and consumer (the app-wide mirror hook) are far apart in the
// tree and the signal is a transient, fire-once fact about the very next
// mutation — exactly what a shared singleton models. Only the true→Done
// transition is suppressed; a later real dismissal of the same item mirrors
// normally.

import type { ItemId } from './types';

const suppressed = new Set<ItemId>();

/** Mark the next Done mirror for this item as suppressed (call immediately
 * before `set('done', true)` on the open-on-newshacker handoff path). */
export function suppressNextDoneMirror(id: ItemId): void {
  suppressed.add(id);
}

/** Consume a pending suppression for this item: returns true (and clears it) if
 * the next Done mirror should be skipped, false otherwise. One-shot. */
export function consumeDoneMirrorSuppression(id: ItemId): boolean {
  return suppressed.delete(id);
}
