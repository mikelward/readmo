-- Readmo client table grants — make the per-user table access explicit.
--
-- 0002_rls.sql / 0004_access_rpcs.sql set up RLS policies and then *revoked*
-- only the write paths (feeds/items writes; subscriptions/item_state INSERT +
-- UPDATE), leaning on Supabase's default privileges to give the `authenticated`
-- role the remaining SELECT/DELETE on the per-user tables. That assumption does
-- not hold on every project: where the default grants were never applied, an
-- authenticated client gets `42501 permission denied for table …` instead of an
-- RLS-filtered (possibly empty) result — e.g. the item_state hydrate 403s, and
-- the subscriptions/items reads behind the feed list + home come back empty.
--
-- RLS still scopes every row to its owner; these grants only restore the
-- table-level privilege the policies were written to gate. We deliberately do
-- NOT re-grant the INSERT/UPDATE that 0004 revoked — those writes still go
-- through the set_item_state / subscribe_to_feed SECURITY DEFINER RPCs.
--
-- Grants are idempotent, so applying this on a project that already had the
-- default privileges is a no-op.

-- Shared, RLS-gated read tables (feeds already granted in 0002; items relied on
-- the default). anon sees nothing useful (the items_select policy keys off
-- auth.uid()), but we mirror feeds' anon+authenticated grant for parity.
grant select on public.items to anon, authenticated;

-- Per-user tables. Writes are RPC-only (item_state) or column-scoped (the
-- subscriptions UPDATE grant in 0004); here we restore the reads and the
-- client-driven deletes the policies already allow (unsubscribe; folder
-- management).
grant select, delete on public.subscriptions to authenticated;
grant select, delete on public.item_state    to authenticated;
grant select, insert, update, delete on public.folders to authenticated;
