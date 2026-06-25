-- Make subscriptions.sort a meaningful per-user order.
--
-- 0016 made the grouped feed view (and the drawer / Settings list) order by
-- `subscriptions.sort`. But every subscription was created with the schema
-- default `0` — `subscribe_to_feed` (0004) never set it — so on a real backend
-- all of a user's feeds tie at 0: Group-by-feed can't section anything (every
-- group_ord is equal, so items just merge by pin/date) and the list order is
-- arbitrary. Three changes fix that:
--
--   1. Backfill: densify each user's existing rows to 0..n-1, preserving their
--      current apparent order (sort, then created_at, then feed_id as a stable
--      tiebreak) so nobody's list visibly reshuffles.
--   2. Append on subscribe: new subscriptions (added or OPML-imported) land at
--      max(sort)+1 for that user, so they don't collide with existing rows.
--   3. Atomic reorder RPC: replace the client's N independent UPDATEs with one
--      statement, so a mid-flight failure can't leave a partially rewritten
--      order with duplicate/gap sort values (which would corrupt the grouped
--      feed order until the next full reorder).

-- 1. Backfill existing per-user orders to dense 0-based ranks.
update public.subscriptions s
set sort = r.rn
from (
  select user_id, feed_id,
         (row_number() over (
            partition by user_id
            order by sort, created_at, feed_id
          ) - 1) as rn
  from public.subscriptions
) r
where s.user_id = r.user_id
  and s.feed_id = r.feed_id
  and s.sort is distinct from r.rn;

-- 2. Append new subscriptions at the end of the user's order. Recreate
-- subscribe_to_feed (0004) unchanged except for the final INSERT, which now sets
-- sort = max(sort)+1 for the caller (0 for their first feed). On-conflict
-- (already subscribed) stays a no-op, so re-subscribing never reshuffles.
create or replace function public.subscribe_to_feed(
  p_url    text,
  p_folder text default null
)
returns setof public.feeds_public
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_url     text := btrim(coalesce(p_url, ''));
  v_feed_id uuid;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if v_url = '' then
    raise exception 'feed url required' using errcode = '22023';
  end if;

  -- Authorize against an existing row by the FETCH url: the public `url` only
  -- when the row carries no secret, or the `secret_url` itself for a
  -- secret-backed row. Presenting just the public url of a secret-backed feed
  -- matches nothing here and is rejected below.
  select id into v_feed_id
  from public.feeds
  where (secret_url is null and url = v_url)
     or (secret_url = v_url)
  limit 1;

  if v_feed_id is null then
    -- No authorized row. Create one — a freshly pasted (possibly tokenized)
    -- URL lands in `url` with secret_url null, so possession of that url is the
    -- proof. New feeds get next_fetch_at = now(), so the poller fills in
    -- title/site_url/health on its next pass. If `url` already exists, the
    -- conflict means a secret-backed row with this PUBLIC url is present and
    -- the caller lacks the token → refuse rather than hand out access.
    insert into public.feeds (url)
    values (v_url)
    on conflict (url) do nothing
    returning id into v_feed_id;

    if v_feed_id is null then
      -- ON CONFLICT returned nothing: a row with this `url` already exists.
      -- That's either (a) a concurrent subscriber who just inserted the SAME
      -- public feed (we lost the insert race), or (b) a secret-backed row whose
      -- public url we presented without its token. Re-run the fetch-url
      -- authorization against the committed row: it succeeds for (a) and still
      -- refuses (b), so legitimate concurrent public subscribes don't fail.
      select id into v_feed_id
      from public.feeds
      where (secret_url is null and url = v_url)
         or (secret_url = v_url)
      limit 1;

      if v_feed_id is null then
        raise exception
          'feed requires its tokenized fetch URL, not the public url'
          using errcode = '42501';
      end if;
    end if;
  end if;

  -- Serialize this user's append computation: concurrent subscribes (e.g. the
  -- multi-feed picker firing ds.subscribe() for several feeds at once) would
  -- otherwise each read the same max(sort) before either commits and tie at the
  -- same value, leaving Group-by-feed / drawer order nondeterministic for them.
  -- A per-user transaction-scoped advisory lock makes the read-then-append
  -- atomic across sessions; it's released at commit. Different users hash to
  -- different keys, so they never block each other.
  perform pg_advisory_xact_lock(hashtext('readmo:sub-sort:' || v_uid::text)::bigint);

  -- Idempotent: re-subscribing is a no-op that still returns the feed. New rows
  -- append at the end of the caller's order (max(sort)+1; 0 for their first).
  insert into public.subscriptions (user_id, feed_id, folder, sort)
  values (
    v_uid, v_feed_id, p_folder,
    coalesce(
      (select max(sort) + 1 from public.subscriptions where user_id = v_uid),
      0
    )
  )
  on conflict (user_id, feed_id) do nothing;

  -- Return the display-safe projection (never the fetch URLs). As a definer
  -- function we read past the view's security_invoker RLS, which is correct:
  -- the caller is now a confirmed subscriber.
  return query
    select * from public.feeds_public where id = v_feed_id;
end;
$$;

-- 3. Atomic reorder: set every named subscription's sort to its position in one
-- statement, scoped to the caller. A single UPDATE is all-or-nothing, so a
-- transient failure can't leave the order half-rewritten. Feed ids not owned by
-- the caller (or already unsubscribed) simply match nothing — no error, no
-- cross-user write. Ids omitted from the array keep their current sort, so they
-- can collide with the reassigned ones; the client passes the full set.
create or replace function public.reorder_subscriptions(p_feed_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.subscriptions s
  set sort = arr.ord
  from (
    select feed_id, (ordinality - 1)::int as ord
    from unnest(p_feed_ids) with ordinality as t(feed_id, ordinality)
  ) arr
  where s.user_id = auth.uid()
    and s.feed_id = arr.feed_id;
$$;

comment on function public.reorder_subscriptions(uuid[]) is
  'Atomically set the caller''s subscription order: each subscriptions.sort is '
  'reassigned to its 0-based position in p_feed_ids, in one UPDATE scoped to '
  'auth.uid(). Drives the drawer / Settings list order and the Group-by-feed '
  'section order. Direct UPDATE of sort stays granted too (single-column edits), '
  'but reorders go through this so a partial failure can''t corrupt the order.';

revoke execute on function public.reorder_subscriptions(uuid[]) from public;
grant  execute on function public.reorder_subscriptions(uuid[]) to authenticated;
