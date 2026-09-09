-- Cap how long a single *user-initiated* query may run.
--
-- PostgREST executes client (REST/RPC) requests as `authenticated` (a logged-in
-- caller) or `anon`, so a per-role statement_timeout bounds the cost of any one
-- interactive read or write: a pathological `feed_items` scan is killed instead
-- of pinning a pooled connection and starving everyone else under load. The
-- browser client already caps reads at 15 s (src/lib/supabase/client.ts), so a
-- 5 s server ceiling sits well inside that and never truncates a healthy query.
-- (This tightens Supabase's generous role defaults; it's the mechanism their
-- docs document for bounding API query duration.)
--
-- Deliberately NOT tightened for `service_role` (the cron poller and the
-- refresh/import Edge Functions run their batch upserts as service_role): we do
-- not impose this 5 s user cap on them. Note this does NOT make batch work
-- unbounded — an unset `service_role` timeout inherits the `authenticator`
-- default (8 s per Supabase's timeouts docs), so a batch statement past ~8 s is
-- still canceled. Whether to raise/remove that for genuinely long syncs (set
-- `service_role` to 0 or a generous value + reload) is the open decision tracked
-- in TODO.md → "Server / batch query limits".
--
-- Role-level GUCs are applied when PostgREST assumes the role for the request.
-- Idempotent — safe to re-apply.
alter role authenticated set statement_timeout = '5s';
alter role anon set statement_timeout = '3s';

-- PostgREST caches role-level settings, so a running API server keeps using the
-- old timeout until told to reload. Without this the new caps wouldn't take
-- effect (on a live project) until a restart. Supabase's timeout docs prescribe
-- exactly this notification after `alter role ... set statement_timeout`.
notify pgrst, 'reload config';
