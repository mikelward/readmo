-- Per-account feed cap on subscribe_to_feed.
--
-- Bounds the number of feeds one account may follow. The primary reason is
-- abuse / cost — a runaway account can't subscribe to an unbounded number of
-- feeds and turn the poller/refresh into an open-ended fetch bill. Secondarily
-- it keeps a typical account's group-by-feed read smaller so it pages against
-- PostgREST's 1000-row response cap less often; note this is a LOOSE bound, not
-- a guarantee — the grouped read returns each feed's full listable set (its
-- freshness window + all pins, NOT the client's 10-row display window), so a few
-- busy feeds can overflow 1000 rows on their own. That read pages by cursor on
-- overflow, so nothing is dropped regardless. See SPEC.md §"Group by feed".
--
-- Enforced server-side inside subscribe_to_feed so it can't be bypassed by a
-- hand-crafted direct RPC call. Rejection uses SQLSTATE 53400
-- (configuration_limit_exceeded); the client maps that code to a typed "feed
-- limit reached" error.
--
-- Concurrency: the cap count-then-insert must be serialized per user, or two
-- concurrent subscribes could both read the same under-cap count and both slip
-- past, blowing the cap. This reuses the SAME per-user advisory lock 0043
-- already takes for the sort-append (a subscribe holds it once, covering both),
-- but the lock is now taken EARLIER — before both the cap check and find-or-
-- create — so (a) the count is serialized and (b) a capped reject for a brand-
-- new URL never creates an orphan `feeds` row. An idempotent re-subscribe to a
-- feed already followed is exempt from the cap.
--
-- Otherwise identical to the 0043 definition (re-stated in full, as Postgres
-- replaces functions wholesale): the FOR KEY SHARE feed-row locks (reaper race,
-- 0043) and the max(sort)+1 append (0017) are preserved. This is `create or
-- replace`, so existing grants (execute to authenticated) carry over.

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
  v_cap     constant int := 100;  -- FEED_CAP; see the file header for the derivation.
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if v_url = '' then
    raise exception 'feed url required' using errcode = '22023';
  end if;

  -- Serialize this user's subscribe path BEFORE resolving the feed, so the whole
  -- resolve → cap decision → append runs atomically across the user's concurrent
  -- sessions (the multi-feed picker firing several ds.subscribe() calls, or a
  -- double-submit of the same URL). The per-user transaction-scoped advisory lock
  -- (released at commit) gives three things: concurrent subscribes can't each
  -- read the same under-cap count and all slip past the cap; the count is taken
  -- before find-or-create so a capped reject leaves no orphan feed row; and,
  -- crucially, the feed resolve below runs UNDER the lock, so a duplicate
  -- concurrent add of the SAME new URL at the cap sees the sibling's just-created
  -- feed + subscription and is recognized as an idempotent re-subscribe instead
  -- of resolving NULL and falsely tripping 53400. Different users hash to
  -- different keys, so they never block each other.
  perform pg_advisory_xact_lock(hashtext('readmo:sub-sort:' || v_uid::text)::bigint);

  -- Authorize against an existing row by the FETCH url: the public `url` only
  -- when the row carries no secret, or the `secret_url` itself for a
  -- secret-backed row. Presenting just the public url of a secret-backed feed
  -- matches nothing here and is rejected below. FOR KEY SHARE locks the resolved
  -- row so the orphan reaper (0042) can't DELETE it out from under the
  -- subscription INSERT below. Resolved under the advisory lock (see above) so a
  -- same-user sibling's committed feed/subscription is visible here.
  select id into v_feed_id
  from public.feeds
  where (secret_url is null and url = v_url)
     or (secret_url = v_url)
  limit 1
  for key share;

  -- Feed cap. Reject only a subscribe that would CREATE a new subscription for
  -- this caller; a re-subscribe to a feed they already follow is idempotent and
  -- exempt (v_feed_id null → not-already-subscribed → the brand-new-feed case,
  -- rejected at the cap before the feed is created).
  if not exists (
    select 1 from public.subscriptions
    where user_id = v_uid and feed_id = v_feed_id
  ) and (
    select count(*) from public.subscriptions where user_id = v_uid
  ) >= v_cap then
    raise exception 'subscription limit reached (max % feeds)', v_cap
      using errcode = '53400';
  end if;

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

comment on function public.subscribe_to_feed(text, text) is
  'Client subscribe path. Authorizes by URL possession (find-or-create feed by '
  'unique url, then subscribe auth.uid()), closing the access-by-UUID '
  'escalation. Caps the caller at 100 feeds (SQLSTATE 53400; idempotent '
  're-subscribes exempt), serialized under the per-user advisory lock. Direct '
  'INSERT on subscriptions is revoked; this is the only client insert path. '
  'See 0002_rls.sql TODO(PR2, P1), 0043 (feed-row lock), and 0059 (cap).';
