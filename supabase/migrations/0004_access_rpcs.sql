-- Readmo access-control RPCs — close the access-by-UUID escalation.
--
-- Background (see the two TODO(PR2, P1) notes in 0002_rls.sql): the per-user
-- INSERT policies on `subscriptions` and `item_state` only checked
-- `user_id = auth.uid()`. They did NOT verify that the caller is allowed to
-- reach the referenced feed/item, so a signed-in user who learned a private
-- feed's or item's UUID could:
--   * insert a `subscriptions` row for that feed_id, satisfying feeds_select /
--     items_select and reading a PRIVATE/tokenized feed's content without ever
--     possessing its URL; or
--   * insert an `item_state` row with pinned/favorite/done on that item_id,
--     satisfying the permanent-state branch of items_select / feeds_select and
--     reading a private item + its feed by UUID alone.
--
-- Fix: route both privileged inserts through SECURITY DEFINER RPCs that prove
-- authorization first, then revoke direct client INSERT on the two tables so
-- the RPCs are the only insert path. UPDATE/DELETE stay direct — they are
-- already RLS-gated to the caller's own rows and a row can only exist if the
-- caller was authorized to create it, so they grant no new access.
--
-- The poller/refresh run as the service role, which bypasses RLS *and* table
-- grants, so revoking authenticated INSERT does not affect server-side writes.

-- ===========================================================================
-- subscribe_to_feed — the ONLY way a client may create a subscription.
--
-- Authorization proof = POSSESSION OF THE URL. The caller supplies the feed
-- URL (exactly what DataSource.subscribe(feedUrl) already has); we find-or-
-- create the shared feed by its UNIQUE url and subscribe auth.uid() to it. A
-- caller who knows only a feed's opaque UUID cannot reach this path (it takes a
-- url, and url is never exposed to clients — see 0002), so they can no longer
-- self-grant a subscription to a private/tokenized feed.
--
-- SECURITY DEFINER so it can insert into feeds/subscriptions (both have client
-- INSERT revoked); `set search_path = ''` + fully-qualified names is the
-- standard hardening against search-path injection in definer functions.
-- ===========================================================================
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

  -- Find-or-create the shared feed row. New feeds get the default
  -- next_fetch_at = now(), so the poller picks them up on its next pass and
  -- fills in title/site_url/health.
  insert into public.feeds (url)
  values (v_url)
  on conflict (url) do nothing;

  select id into v_feed_id from public.feeds where url = v_url;

  -- Idempotent: re-subscribing is a no-op that still returns the feed.
  insert into public.subscriptions (user_id, feed_id, folder)
  values (v_uid, v_feed_id, p_folder)
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
  'escalation. Direct INSERT on subscriptions is revoked; this is the only '
  'client insert path. See 0002_rls.sql TODO(PR2, P1).';

-- ===========================================================================
-- set_item_state — the ONLY way a client may CREATE an item_state row (it also
-- handles updates, so the client can route every triage write through it).
--
-- Authorization proof = CURRENT VISIBILITY. Before writing, the caller must
-- already be able to see the item under the items_select RLS rule: either they
-- subscribe to the item's feed, OR they already hold a PERMANENT
-- (pinned/favorite/done) state row on it. Hidden/opened-only rows grant no
-- visibility, so they cannot bootstrap a permanent write on an item the caller
-- never had access to — which is the escalation we are closing.
--
-- NULL params mean "leave unchanged" (the client mutates one field per write);
-- on insert they default to false. The item_state_bump trigger (0003) still
-- assigns version, stamps *_at, and enforces pin/done/hidden exclusivity.
-- ===========================================================================
create or replace function public.set_item_state(
  p_item_id  uuid,
  p_pinned   boolean default null,
  p_favorite boolean default null,
  p_done     boolean default null,
  p_hidden   boolean default null,
  p_opened   boolean default null
)
returns public.item_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.item_state;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- Visibility gate — mirrors items_select in 0002_rls.sql exactly.
  if not exists (
    select 1
    from public.subscriptions s
    join public.items i on i.feed_id = s.feed_id
    where i.id = p_item_id and s.user_id = v_uid
  ) and not exists (
    select 1 from public.item_state st
    where st.item_id = p_item_id and st.user_id = v_uid
      and (st.pinned or st.favorite or st.done)
  ) then
    raise exception 'item % not visible to caller', p_item_id
      using errcode = '42501';
  end if;

  insert into public.item_state as st
    (user_id, item_id, pinned, favorite, done, hidden, opened)
  values (
    v_uid, p_item_id,
    coalesce(p_pinned,   false),
    coalesce(p_favorite, false),
    coalesce(p_done,     false),
    coalesce(p_hidden,   false),
    coalesce(p_opened,   false)
  )
  on conflict (user_id, item_id) do update set
    pinned   = coalesce(p_pinned,   st.pinned),
    favorite = coalesce(p_favorite, st.favorite),
    done     = coalesce(p_done,     st.done),
    hidden   = coalesce(p_hidden,   st.hidden),
    opened   = coalesce(p_opened,   st.opened)
  returning st.* into v_row;

  return v_row;
end;
$$;

comment on function public.set_item_state(uuid, boolean, boolean, boolean, boolean, boolean) is
  'Client item_state write path (upsert). Gates on current item visibility '
  '(subscription or existing permanent state), so a hidden/opened row cannot '
  'bootstrap access to a private item by UUID. Direct INSERT on item_state is '
  'revoked. See 0002_rls.sql TODO(PR2, P1).';

-- ===========================================================================
-- Lock down the direct insert paths and the RPC grants.
-- ===========================================================================
-- The RPCs (SECURITY DEFINER, owned by the migration role) remain the only way
-- to insert these rows; the service role still bypasses this entirely.
revoke insert on public.subscriptions from anon, authenticated;
revoke insert on public.item_state    from anon, authenticated;

-- Definer functions default to EXECUTE for PUBLIC; restrict to signed-in users.
revoke execute on function public.subscribe_to_feed(text, text) from public;
grant  execute on function public.subscribe_to_feed(text, text) to authenticated;

revoke execute on function public.set_item_state(uuid, boolean, boolean, boolean, boolean, boolean) from public;
grant  execute on function public.set_item_state(uuid, boolean, boolean, boolean, boolean, boolean) to authenticated;
