-- Readmo service-role grants for the poller Edge Function.
--
-- The service role bypasses RLS but still requires table-level privileges
-- (unlike the postgres superuser). Without these grants the poller's
-- createClient(..., serviceKey) receives "permission denied for table feeds"
-- even though relforcerowsecurity is false.
--
-- Grants are idempotent — safe to apply on projects that already have them.

grant select, insert, update, delete on public.feeds to service_role;
grant select, insert, update, delete on public.items to service_role;
