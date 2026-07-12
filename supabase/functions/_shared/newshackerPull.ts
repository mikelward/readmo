// Pull side of the newshacker mirror (reverse sync): turn newshacker's
// GET /api/sync response body into the Done + Pinned entries Readmo applies to
// item_state via the `apply_newshacker_state` RPC (0063). The forward push
// lives in newshacker-sync/index.ts; this is the parser for the pull the
// Edge Function's GET branch performs. Kept in _shared/ (not the Deno-only
// index.ts entry file) so it's unit-tested and counts toward coverage.

/** One newshacker sync-list entry: the numeric HN item id, the action time
 * (last-write-wins clock, ms since epoch), and a tombstone flag for a removal
 * (un-done / unpin). Same wire shape newshacker's /api/sync uses. */
export interface PulledEntry {
  id: number;
  at: number;
  deleted?: true;
}

/** Back-compat alias — the Done pull (0062) named this `PulledDoneEntry`. */
export type PulledDoneEntry = PulledEntry;

/** Normalize one newshacker sync list (`done` / `pinned`). Keeps only
 * well-formed `{ id:int>0, at:number>=0, deleted?:true }` entries, newest-first
 * (highest `at`), capped at `max`. Sorting before the cap means that when it
 * bites we keep the most RECENT actions — the ones most likely to still map to
 * an item inside Readmo's freshness window. Anything malformed is dropped
 * rather than failing the batch (best-effort, like the push path's
 * `normalizeEntries`). */
function normalizeList(value: unknown, max: number): PulledEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PulledEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== 'number' || !Number.isSafeInteger(e.id) || e.id <= 0) {
      continue;
    }
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at < 0) continue;
    const entry: PulledEntry = { id: e.id, at: e.at };
    if (e.deleted === true) entry.deleted = true;
    out.push(entry);
  }
  out.sort((a, b) => b.at - a.at);
  return out.length > max ? out.slice(0, max) : out;
}

/** Extract + normalize the `done` list from a newshacker /api/sync GET body. */
export function extractDoneEntries(body: unknown, max = 1000): PulledEntry[] {
  if (typeof body !== 'object' || body === null) return [];
  return normalizeList((body as Record<string, unknown>).done, max);
}

/** Extract + normalize the `pinned` list from a newshacker /api/sync GET body. */
export function extractPinnedEntries(body: unknown, max = 1000): PulledEntry[] {
  if (typeof body !== 'object' || body === null) return [];
  return normalizeList((body as Record<string, unknown>).pinned, max);
}
