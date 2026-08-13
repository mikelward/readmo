// Fill items.title_normalized for rows the writers didn't cover.
//
// WHY A PASS AND NOT A MIGRATION. The value is produced by JavaScript
// (titleFilterCore.ts) precisely because SQL can't fold reliably — so a SQL
// backfill would write values that disagree with the client for exactly the
// scripts this design exists to fix. It has to run somewhere with a JS runtime,
// and the poller already runs every few minutes.
//
// WHY NOT JUST WAIT FOR RE-POLLING. Re-polling is not a backfill. A conditional
// GET returning 304 makes the poller bump last_fetched_at and return before it
// parses or upserts anything, and paused, failing and rate-limited feeds skip
// the write too — so with a published title rarely changing, most existing rows
// would never be rewritten at all.
//
// WHY IT IGNORES WHICH FEEDS POLLED. The spoiler-title pass takes
// `processedFeedIds`, collected after pollOne succeeds, and feeds_due_for_poll
// excludes paused feeds outright. Inheriting that scoping would strand exactly
// the rows this pass exists to reach. It selects the backlog directly.
//
// TWO ROUND TRIPS, NOT 2N. The folding must happen here, but the writes go back
// as a single jsonb batch through apply_title_normalizations. Up to 500 serial
// PostgREST updates would sit inside the poll's wall clock behind its feed loop
// and the spoiler pass, where ordinary latency could push the scheduled
// invocation past its limit or overlap the next run.

import { normalizeTitle, TITLE_NORMALIZED_VERSION } from './titleFilterCore.ts';

/** Rows repaired per poll. The backlog drains over a few polls on a real
 * library and the work stays bounded on any library; the index on
 * (title_normalized_version, id) is what keeps the *lookup* bounded too once
 * it's empty. */
export const BACKFILL_ITEMS_PER_RUN = 500;

interface BackfillRow {
  id: string;
  title: string | null;
}

/** The subset of the Supabase client this pass needs. Structural so the unit
 * test needs no live database. */
export interface BackfillClient {
  from(table: string): {
    select(cols: string): {
      or(filter: string): {
        order(col: string, opts: { ascending: boolean }): {
          limit(n: number): Promise<{ data: BackfillRow[] | null; error: { message: string } | null }>;
        };
      };
    };
  };
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: number | null; error: { message: string } | null }>;
}

export interface BackfillResult {
  /** Rows selected as needing work. */
  considered: number;
  /** Rows the batch actually updated, as counted by the RPC. Short of
   * `considered` when a title moved under the pass — those stay in the backlog
   * and the next run picks them up. */
  written: number;
  /** Whether the pass failed (select or write). Logged, never thrown: the poll
   * has already stored its items and this is not a reason to fail it. */
  failed: boolean;
}

/**
 * Repair one bounded batch of the backlog.
 *
 * The backlog is `title_normalized_version is null or < TITLE_NORMALIZED_VERSION`,
 * which covers both a row that has never been normalized and one left on an
 * older normalizer after a version bump. Ordering by id makes the scan
 * resumable and, with items_title_normalized_backlog_idx, makes "there is no
 * work" a small index scan rather than a table scan on every poll.
 *
 * The compare-and-swap that guards each write lives in the RPC — see its
 * comment in migration 0073 for why it is not optional.
 */
export async function runTitleNormalizeBackfill(
  supabase: BackfillClient,
): Promise<BackfillResult> {
  const { data, error } = await supabase
    .from('items')
    .select('id, title')
    .or(
      `title_normalized_version.is.null,title_normalized_version.lt.${TITLE_NORMALIZED_VERSION}`,
    )
    .order('id', { ascending: true })
    .limit(BACKFILL_ITEMS_PER_RUN);

  if (error) {
    console.error('poll: title-normalize backlog select failed:', error.message);
    return { considered: 0, written: 0, failed: true };
  }

  const rows = data ?? [];
  if (rows.length === 0) return { considered: 0, written: 0, failed: false };

  const payload = rows.map((row) => ({
    id: row.id,
    // Sent so the RPC can compare-and-swap on it. normalizeTitle applies the
    // client's `(untitled)` fallback, so both sides see the same text for an
    // untitled row.
    title: row.title,
    title_normalized: normalizeTitle(row.title),
    title_normalized_version: TITLE_NORMALIZED_VERSION,
  }));

  const { data: written, error: writeError } = await supabase.rpc(
    'apply_title_normalizations',
    { p_rows: payload },
  );

  if (writeError) {
    // Soft: the rows stay in the backlog and the next poll retries them. This
    // also covers a poller deployed ahead of the migration, where the function
    // doesn't exist yet.
    console.error('poll: title-normalize batch write failed:', writeError.message);
    return { considered: rows.length, written: 0, failed: true };
  }

  return { considered: rows.length, written: written ?? 0, failed: false };
}
