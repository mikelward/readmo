/**
 * The `/debug` "Pending writes" row value, from a DataSource's `pendingItemIds()`
 * — the count of item-state writes (pin / favorite / done / hidden / opened) the
 * offline outbox has queued but not yet delivered to the server:
 *
 *  - `undefined` → the source has no outbox (mock data), so nothing is ever
 *    pending; the row reads N/A.
 *  - `0` → a real backend with the outbox drained; every local write has synced.
 *  - `number` → writes still queued (offline, retrying, or just enqueued). A
 *    count that *stays* non-zero across reloads is a stalled outbox — the signal
 *    that a swept/done item never reached the server, so it resurfaces elsewhere.
 *
 * Paired with "Last sync" (the inbound pull) this splits the two sync failure
 * modes: stuck-outbox (writes never leave) vs. a server-side clobber (writes
 * left, but a newer write overwrote them).
 */
export function formatPendingWrites(count: number | undefined): string {
  if (count === undefined) return 'n/a (mock data)';
  if (count === 0) return 'none';
  return String(count);
}
