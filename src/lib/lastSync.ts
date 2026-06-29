import { formatTimeAgoLong } from './format';

/**
 * The `/debug` "Last sync" row value, from a DataSource's `getLastSyncedAt()`:
 *
 *  - `undefined` → the source has no server to reconcile against (mock data),
 *    so there's nothing to sync.
 *  - `null` → a real backend, but no `item_state` pull has completed yet this
 *    session.
 *  - `number` → epoch ms of the last successful pull, rendered relative
 *    ("just now", "3 minutes ago").
 */
export function formatLastSync(
  at: number | null | undefined,
  now: number = Date.now(),
): string {
  if (at === undefined) return 'n/a (mock data)';
  if (at === null) return 'not yet';
  return formatTimeAgoLong(Math.floor(at / 1000), new Date(now));
}
