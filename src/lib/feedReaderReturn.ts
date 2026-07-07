/**
 * Records that the in-app reader was opened *from* a given feed view, so that
 * view can skip its refetch when the user navigates Back to it. Returning from
 * the reader should paint the cached list, not fire a fetch that reflows it a
 * beat later — right as a tap is aimed at a new card. (Fresh data still arrives
 * on the forward path via prefetch-on-open, and via focus / pull-to-refresh /
 * cross-device sync.)
 *
 * Module-scoped rather than React state because the feed route unmounts while
 * the reader is up (they're sibling routes): the signal has to outlive the
 * component instance that set it and be read by the fresh instance that mounts
 * on Back. It's a single pending view key, set on open and consumed once on the
 * next matching mount — so boot (which never opened a reader) still validates
 * normally, and only a genuine reader round-trip suppresses the fetch.
 */
let pendingReturnViewKey: string | null = null;

/** Called when a row opens the in-app reader from the given feed view. */
export function markFeedReaderOpen(viewKey: string): void {
  pendingReturnViewKey = viewKey;
}

/**
 * True exactly once if the last reader open came from this view — i.e. this
 * mount is the Back-return to it. Clears the pending flag so a later, unrelated
 * visit to the same view refetches normally.
 */
export function consumeFeedReaderReturn(viewKey: string): boolean {
  if (pendingReturnViewKey !== viewKey) return false;
  pendingReturnViewKey = null;
  return true;
}

/** Test helper: clear any pending return between tests. */
export function resetFeedReaderReturnForTest(): void {
  pendingReturnViewKey = null;
}
