-- Poll-batch selection: due feeds that still have at least one subscriber.
--
-- SPEC.md "Polling (the cron)": the scheduler selects feeds with
-- `next_fetch_at <= now()` AND ≥1 subscriber. The poll Edge Function's batch
-- query historically applied only the `next_fetch_at` half (the subscriber
-- EXISTS was a standing TODO — PostgREST can't express it cleanly), so a feed
-- with zero subscribers was still fetched every cycle. 0042's reaper deletes
-- the fully-abandoned case (no subscribers AND nothing kept), but a feed kept
-- alive solely by someone's pinned/favorite/done item (RLS branch (b)) survives
-- the reap and would otherwise keep being polled — the poller would keep
-- calling the publisher and upserting items nobody can read, which is worst for
-- tokenized/private feeds.
--
-- This function moves the full selection (both predicates + ordering + limit)
-- into SQL so the poller stops fetching any zero-subscriber feed while its kept
-- items stay put (we stop polling, we don't delete). Ordered by next_fetch_at
-- so the most-overdue feeds go first and the feeds_next_fetch_idx (0032) serves
-- both the range predicate and the ordering. Returns the exact columns pollOne
-- needs, including the server-only fetch URLs (secret_url) — so it's
-- service-role-only, never granted to clients.

create or replace function public.feeds_due_for_poll(p_limit integer)
returns table (
  id               uuid,
  url              text,
  secret_url       text,
  etag             text,
  last_modified    text,
  fetch_interval_s integer,
  error_count      integer,
  favicon_url      text
)
language sql
security definer
set search_path = ''
as $$
  select f.id, f.url, f.secret_url, f.etag, f.last_modified,
         f.fetch_interval_s, f.error_count, f.favicon_url
  from public.feeds f
  where f.next_fetch_at <= now()
    and exists (
          select 1 from public.subscriptions s where s.feed_id = f.id
        )
  order by f.next_fetch_at asc
  limit p_limit;
$$;

comment on function public.feeds_due_for_poll(integer) is
  'Poll-batch selection for the cron: the p_limit most-overdue feeds '
  '(next_fetch_at <= now()) that still have >= 1 subscriber, newest-overdue '
  'first. Returns the poller''s columns incl. the server-only fetch URLs, so '
  'it is service-role-only. Skips zero-subscriber feeds (incl. those kept alive '
  'by a pin/favorite/done) so we never poll a feed nobody is subscribed to.';

-- Server-only: exposes secret_url and is the cron's selection path. Only the
-- poller (service role) may call it.
revoke execute on function public.feeds_due_for_poll(integer) from public;
grant  execute on function public.feeds_due_for_poll(integer) to service_role;
