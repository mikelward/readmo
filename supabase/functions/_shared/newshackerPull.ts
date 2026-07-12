// Pull side of the newshacker mirror (reverse sync): turn newshacker's
// GET /api/sync response body into the Done entries Readmo applies to
// item_state via the `apply_newshacker_dones` RPC (0061). The forward push
// lives in newshacker-sync/index.ts; this is the parser for the pull the
// Edge Function's GET branch performs. Kept in _shared/ (not the Deno-only
// index.ts entry file) so it's unit-tested and counts toward coverage.

/** One newshacker Done list entry: the numeric HN item id, the action time
 * (last-write-wins clock, ms since epoch), and a tombstone flag for an
 * un-done. Same wire shape newshacker's /api/sync uses. */
export interface PulledDoneEntry {
  id: number;
  at: number;
  deleted?: true;
}

/**
 * Extract + normalize the `done` list from a newshacker /api/sync GET body.
 * Keeps only well-formed `{ id:int>0, at:number>=0, deleted?:true }` entries,
 * newest-first (highest `at`), capped at `max`. Sorting before the cap means
 * that when it bites we keep the most RECENT dismissals — the ones most likely
 * to still map to an item inside Readmo's freshness window. Anything malformed
 * is dropped rather than failing the batch (best-effort, like the push path's
 * `normalizeEntries`).
 */
export function extractDoneEntries(
  body: unknown,
  max = 1000,
): PulledDoneEntry[] {
  if (typeof body !== 'object' || body === null) return [];
  const done = (body as Record<string, unknown>).done;
  if (!Array.isArray(done)) return [];
  const out: PulledDoneEntry[] = [];
  for (const raw of done) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== 'number' || !Number.isSafeInteger(e.id) || e.id <= 0) {
      continue;
    }
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at < 0) continue;
    const entry: PulledDoneEntry = { id: e.id, at: e.at };
    if (e.deleted === true) entry.deleted = true;
    out.push(entry);
  }
  out.sort((a, b) => b.at - a.at);
  return out.length > max ? out.slice(0, max) : out;
}
