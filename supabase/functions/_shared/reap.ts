// Orphan-feed reaper — the thin TypeScript wrapper the `poll` Edge Function
// uses to invoke the `reap_orphan_feeds()` SQL function (migration 0042). The
// deletion logic itself lives in SQL (a single set-based DELETE with the
// permanent-state exemption); this just calls it and surfaces the count, so
// vitest can exercise the call/error handling without a Deno/DB runtime — same
// split as poller.ts. See SPEC.md "Polling (the cron)".

/** Minimal shape of the Supabase client the reaper needs — a single RPC that
 * returns the reaped-feed count. Typed structurally so this module stays free
 * of the supabase-js types (it's shared with vitest unit tests). */
export interface ReapDbClient {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: number | null; error: { message?: string } | null }>;
}

/**
 * Delete every feed that has no subscribers and no kept
 * (pinned/favorite/done) item_state — see 0042_reap_orphan_feeds.sql for the
 * exact condition and why the permanent-state exemption is required. Returns
 * the number of feeds reaped. Throws on an RPC error so the caller can log it;
 * the poller treats a reap failure as non-fatal (GC, not the fetch itself).
 */
export async function reapOrphanFeeds(supabase: ReapDbClient): Promise<number> {
  const { data, error } = await supabase.rpc('reap_orphan_feeds', {});
  if (error) {
    throw new Error(`reap_orphan_feeds failed: ${error.message ?? 'unknown error'}`);
  }
  return data ?? 0;
}
