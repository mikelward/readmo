-- Lock the candidate feed row in subscribe_to_feed against the orphan reaper.
--
-- 0042 added reap_orphan_feeds(), which the poller runs to DELETE feeds with no
-- subscribers. That races with re-subscribing to a previously abandoned feed:
-- subscribe_to_feed resolves an existing feed row by URL, then inserts the
-- subscription only AFTER taking its per-user sort advisory lock. In the gap
-- between the resolve SELECT and the subscription INSERT, the reaper's DELETE
-- can commit (the row still has no subscribers), and the INSERT then fails its
-- feed_id foreign key — surfacing as an intermittent "Add feed" error even
-- though a retry would just recreate the feed.
--
-- Fix: take a FOR KEY SHARE row lock when resolving the feed. That lock conflicts
-- with the reaper's DELETE, so the reaper blocks until this subscribe commits;
-- its `NOT EXISTS (subscriptions)` predicate then re-evaluates (EvalPlanQual)
-- against the now-committed subscription and skips the row. FOR KEY SHARE is the
-- weakest row lock and does NOT conflict with other concurrent FOR KEY SHARE
-- holders, so legitimate parallel subscribes to the same feed are unaffected.
--
-- Otherwise identical to the 0017 definition (re-stated in full, as Postgres
-- replaces functions wholesale).

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
  -- matches nothing here and is rejected below. FOR KEY SHARE locks the resolved
  -- row so the orphan reaper (0042) can't DELETE it out from under the
  -- subscription INSERT below.
  select id into v_feed_id
  from public.feeds
  where (secret_url is null and url = v_url)
     or (secret_url = v_url)
  limit 1
  for key share;

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
      -- FOR KEY SHARE again, for the same reaper-race reason as above.
      select id into v_feed_id
      from public.feeds
      where (secret_url is null and url = v_url)
         or (secret_url = v_url)
      limit 1
      for key share;

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
