-- Read-only database performance diagnostics.
--
-- Answers one question: "WHICH query or query group is starving the database
-- right now?" — to be called *after* an out-of-band monitor (the Supabase
-- Metrics API scraped by Grafana Cloud; see OBSERVABILITY.md) has already paged
-- the operator that the DB as a whole is saturated.
--
-- Why it's shaped this way (full reasoning in OBSERVABILITY.md):
--  * DETECTION + paging live OUTSIDE the database. Grafana scrapes the Metrics
--    API over HTTPS, so the alert (and the "DB is down" alert, which is just a
--    failed scrape) does not share fate with the database and adds zero load to
--    it. Nothing here runs on a timer.
--  * This function therefore only does ATTRIBUTION, on demand, and is strictly
--    READ-ONLY — we never write to a database that is already struggling. It is
--    invoked by the `db-perf` Edge Function (which a Grafana alert links to, or
--    the operator curls) with the service role.
--  * `pg_stat_statements` reports normalized query *groups* (literals collapsed
--    to `$1, $2, …`), so no user data leaks through the returned query text.
--    `pg_stat_activity` reports the in-flight long-runners; its `query` text can
--    contain literals, so we truncate it and keep the function service-role only.

-- Idempotent: on managed Supabase the extension already exists in the
-- `extensions` schema, so this is a no-op there; the unqualified references
-- below resolve through the function's search_path either way.
create extension if not exists pg_stat_statements;

create or replace function public.db_perf_diagnostics(
  p_active_ms integer default 10000,  -- in-flight query age (ms) that counts as long-running
  p_limit     integer default 10      -- max active queries / query groups to return
)
returns jsonb
language sql
security definer
-- `extensions` carries pg_stat_statements on managed Supabase; include it (and
-- pg_catalog) so the unqualified references below resolve regardless of where
-- the extension was installed.
set search_path = public, extensions, pg_catalog
-- Bound the diagnostic itself: a catalog scan on a thrashing DB must not become
-- one more long-running query. 3s sits under the 5s authenticated user cap.
set statement_timeout = '3s'
stable
as $$
  with active as (
    select coalesce(jsonb_agg(a order by a.duration_ms desc), '[]'::jsonb) as rows
    from (
      select
        pid,
        usename                                                          as username,
        state,
        wait_event_type,
        wait_event,
        round(extract(epoch from (now() - query_start)) * 1000)::bigint  as duration_ms,
        left(query, 300)                                                 as query
      from pg_stat_activity
      where state is distinct from 'idle'
        and query_start is not null
        and now() - query_start >= make_interval(secs => p_active_ms / 1000.0)
        and pid <> pg_backend_pid()        -- never report the diagnostic's own query
        and backend_type = 'client backend' -- skip autovacuum / walwriter / bg workers
      order by duration_ms desc
      limit greatest(p_limit, 0)
    ) a
  ),
  top as (
    select coalesce(jsonb_agg(s order by s.total_exec_ms desc), '[]'::jsonb) as rows
    from (
      select
        queryid::text                       as queryid,
        calls,
        round(mean_exec_time::numeric, 1)   as mean_exec_ms,
        round(total_exec_time::numeric, 1)  as total_exec_ms,
        round(max_exec_time::numeric, 1)    as max_exec_ms,
        rows                                as row_count,
        left(query, 300)                    as query  -- normalized ($1, $2…); no literals
      from pg_stat_statements
      order by total_exec_time desc
      limit greatest(p_limit, 0)
    ) s
  )
  select jsonb_build_object(
    'captured_at', now(),
    'active', (select rows from active),
    'top',    (select rows from top)
  );
$$;

-- SECURITY: RLS does not apply inside a SECURITY DEFINER function, and this
-- surfaces query text + activity across EVERY session. It must never be callable
-- as anon/authenticated — only the service role (the `db-perf` Edge Function).
revoke all on function public.db_perf_diagnostics(integer, integer) from public;
revoke all on function public.db_perf_diagnostics(integer, integer) from anon, authenticated;
grant execute on function public.db_perf_diagnostics(integer, integer) to service_role;
