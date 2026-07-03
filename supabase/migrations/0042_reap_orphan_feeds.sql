-- Reap feeds that no longer have any subscribers.
--
-- Feeds are SHARED storage polled once per distinct URL regardless of
-- subscriber count (0001 / SPEC.md "Schema"). When the last subscriber leaves
-- (unsubscribe, account deletion, or an admin deleting a user — all of which
-- cascade away `subscriptions` rows), the feed row lingers: the poller keeps
-- fetching it and we keep storing items nobody can read. This function is the
-- garbage collector — the poller calls it once per run (service role) before
-- selecting the batch, so an abandoned feed is dropped instead of polled.
--
-- The catch (guardrail #7 / SPEC.md RLS branch (b)): unsubscribing must NOT
-- orphan a user's KEPT items. `feeds.id ← items.feed_id ← item_state.item_id`
-- all cascade ON DELETE, so deleting a feed would also delete any
-- Pinned/Favorite/Done item a user is holding from it — exactly the kept
-- content branch (b) exists to protect. So the reap condition is "no
-- subscribers AND no permanent (pinned/favorite/done) item_state on any of the
-- feed's items", mirroring the feeds_select visibility test in 0002. A feed
-- kept alive solely by someone's pin survives (its items stay reachable via
-- branch (b)); once that last pin/favorite/done is cleared and the feed still
-- has no subscribers, the next poll run reaps it.
--
-- Hidden/Opened are TTL'd and get NO exemption here, same as the RLS policy.

create or replace function public.reap_orphan_feeds()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  reaped integer;
begin
  with gone as (
    delete from public.feeds f
    where not exists (
            select 1 from public.subscriptions s
            where s.feed_id = f.id
          )
      and not exists (
            select 1
            from public.item_state st
            join public.items i on i.id = st.item_id
            where i.feed_id = f.id
              and (st.pinned or st.favorite or st.done)
          )
    returning 1
  )
  select count(*) into reaped from gone;
  return reaped;
end;
$$;

comment on function public.reap_orphan_feeds() is
  'Deletes every feed that has no subscribers AND no permanent '
  '(pinned/favorite/done) item_state on any of its items — via ON DELETE '
  'CASCADE this also drops its items and their sparse per-user rows. Returns the '
  'number of feeds reaped. Called by the poller (service role) once per run. '
  'The permanent-state exemption mirrors the feeds_select RLS test (0002) so a '
  'user''s kept items are never garbage-collected out from under them.';

-- System-wide destructive GC — only the poller (service role) may run it.
-- Clients never trigger a feed delete (the /admin console has its own
-- admin-gated admin_delete_feed for the manual case).
revoke execute on function public.reap_orphan_feeds() from public;
grant  execute on function public.reap_orphan_feeds() to service_role;
