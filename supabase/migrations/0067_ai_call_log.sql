-- AI call observability (`/admin/ai`): a server-only log of every Gemini call.
--
-- The operator wants to see WHY the AI features (article summaries and the
-- spoiler-free sports headlines) are or aren't producing results — both run
-- through the same Gemini / `GOOGLE_API_KEY` path, so when one is silently doing
-- nothing (key unset, quota, a transient 5xx, everything classified as "no
-- rewrite") the only signal today is buried in Edge Function logs.
--
-- This records the OUTCOME of each generation call — `summary` (the reader's AI
-- summary Edge Function) and `spoiler` (the poll-time headline classifier) — as
-- a row: which kind, the terminal status, the model's HTTP code when there was a
-- response, the item it was for, and a short error. Mirrors item_fulltext_status
-- (0039): its own server-only table, written by the Edge Functions with the
-- service role, read only by an admin-gated (is_admin) SECURITY DEFINER RPC. It
-- never rides a client read path and holds no gated content — operational
-- metadata only.
--
-- Cost/growth: one small insert per Gemini call. Those calls are already bounded
-- (summaries: distinct pinned/requested articles; spoilers: new items in
-- allowlisted-subscriber feeds), so volume is low; `prune_ai_call_log` (called
-- best-effort by the poller) caps retention at a rolling window so the table
-- can't grow without bound. Negligible.

create table if not exists public.ai_call_log (
  id           bigint generated always as identity primary key,
  -- Which generation path made the call.
  kind         text        not null check (kind in ('summary', 'spoiler')),
  -- The terminal outcome. summary: 'ok' | 'empty' | 'unavailable' | 'unreachable'
  -- | 'accepted' (the pin-trigger fire-and-forget ack). spoiler: 'rewrite' (a
  -- spoiler → cached a rewrite) | 'none' (classified, not a spoiler) | 'failed'
  -- (transient failure, retried next poll). Kept as free text (not an enum) so a
  -- new status never needs a migration to be recordable.
  status       text        not null,
  -- The model's HTTP status when the call reached Gemini and got a response
  -- (e.g. 200, 429, 503). NULL when the call never reached the model (key unset,
  -- a pre-call gate) or failed at the transport level (timeout / network).
  http_status  int,
  -- The item the call was for, so the admin view can name it. ON DELETE SET NULL
  -- keeps the log row (and its status history) even after the item is reaped.
  item_id      uuid        references public.items(id) on delete set null,
  -- A short human reason for a non-success outcome (a network/error message),
  -- clamped by the writer. NULL when uninformative.
  error        text,
  created_at   timestamptz not null default now()
);

-- The admin read orders by recency and (for the counts view) filters a time
-- window; both are served by this single descending-time index.
create index if not exists ai_call_log_created_at_idx
  on public.ai_call_log (created_at desc);

comment on table public.ai_call_log is
  'Server-only log of Gemini generation calls (kind=summary|spoiler): terminal '
  'status, model HTTP code, item, short error. Written by the summary + poll '
  'Edge Functions with the service role; read only by the admin-gated '
  'admin_ai_call_log / admin_ai_call_counts RPCs. Operational metadata, kept off '
  'all client reads (its own table, RLS-locked, no authenticated grant). Bounded '
  'by prune_ai_call_log.';

-- Fail closed: RLS on, no anon/authenticated policy → clients can never read or
-- write it. The Edge Functions write it with the service role (bypasses RLS);
-- the admin RPCs read it as SECURITY DEFINER.
alter table public.ai_call_log enable row level security;

revoke all on public.ai_call_log from anon, authenticated;
grant select, insert, delete on public.ai_call_log to service_role;

-- Rolling-window retention. Called best-effort by the poller each run so the log
-- can't grow unbounded without needing a scheduled job. Returns the number of
-- rows pruned (for the poll log line). SECURITY DEFINER so the service-role
-- caller runs it under the table owner; no client grant.
create or replace function public.prune_ai_call_log(p_keep_days int default 14)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from public.ai_call_log
  where created_at < now() - make_interval(days => greatest(p_keep_days, 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.prune_ai_call_log(int) from public, anon, authenticated;
grant  execute on function public.prune_ai_call_log(int) to service_role;

-- Admin-only recent-calls read for /admin/ai. Newest first, capped. Joins the
-- item for a display title (NULL when the item was reaped — the row survives).
create or replace function public.admin_ai_call_log(p_limit int default 200)
returns table (
  id          bigint,
  kind        text,
  status      text,
  http_status int,
  item_id     uuid,
  item_title  text,
  error       text,
  created_at  timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  return query
    select
      l.id, l.kind, l.status, l.http_status, l.item_id,
      i.title as item_title,
      l.error, l.created_at
    from public.ai_call_log l
    left join public.items i on i.id = l.item_id
    order by l.created_at desc, l.id desc
    limit greatest(coalesce(p_limit, 200), 0);
end;
$$;

comment on function public.admin_ai_call_log(int) is
  'Admin-only (is_admin) recent AI generation calls for /admin/ai: newest-first '
  'ai_call_log rows (kind/status/http_status/item/error/when) with the item '
  'title joined for display (null when the item was reaped). Fails closed for '
  'non-admins (42501).';

revoke execute on function public.admin_ai_call_log(int) from public, anon, authenticated;
grant  execute on function public.admin_ai_call_log(int) to authenticated;

-- Admin-only aggregate: call counts grouped by (kind, status) over a recent
-- window, so the console can show an at-a-glance health tally beyond the fetched
-- page (e.g. "summary: 12 ok, 3 unreachable, 40 unavailable in the last 24h").
create or replace function public.admin_ai_call_counts(p_since_hours int default 24)
returns table (
  kind   text,
  status text,
  count  bigint
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  return query
    select l.kind, l.status, count(*) as count
    from public.ai_call_log l
    where l.created_at >= now() - make_interval(hours => greatest(coalesce(p_since_hours, 24), 1))
    group by l.kind, l.status
    order by l.kind asc, count desc, l.status asc;
end;
$$;

comment on function public.admin_ai_call_counts(int) is
  'Admin-only (is_admin) tally of AI generation calls grouped by (kind, status) '
  'over the last p_since_hours (default 24) for the /admin/ai health summary. '
  'Fails closed for non-admins (42501).';

revoke execute on function public.admin_ai_call_counts(int) from public, anon, authenticated;
grant  execute on function public.admin_ai_call_counts(int) to authenticated;
