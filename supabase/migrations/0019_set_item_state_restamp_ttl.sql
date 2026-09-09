-- Re-stamp TTL'd timestamps when set_item_state re-asserts a flag as true.
--
-- Background: making Done a 30-day TTL'd flag (0018 + client withRetention)
-- exposed a write-path gap. The 0003 trigger stamps `*_at = now()` only on a
-- `not old.<f> → true` transition. But once Done is TTL'd, an item can sit in
-- the store with `done = true` while its `done_at` is already past the window,
-- so the read-time collapse shows it as not-Done. When the user re-dismisses it
-- (e.g. a publisher reissued the GUID and the poller refreshed published_at, so
-- the item re-entered the freshness window), the client now correctly sends
-- `p_done = true` — but the existing server row is still `done = true`, so the
-- trigger sees no transition and keeps the stale `done_at`. The item would then
-- resurface after the next hydrate instead of staying dismissed for a fresh 30
-- days.
--
-- Fix: in the ON CONFLICT update, set each TTL'd flag's `*_at` explicitly from
-- its param — `now()` when the field is EXPLICITLY written true, NULL when
-- written false, and unchanged when the param is NULL (field untouched). On a
-- true→true write the 0003 trigger leaves the supplied `*_at` intact (its
-- transition branches don't fire), so the refresh sticks; on a false→true or
-- →false write the trigger's own stamping agrees with these values, and the
-- pin-clears-Done exclusivity path still nulls `done_at` via the trigger. Only
-- Done/Hidden/Opened are TTL'd; Pinned/Favorite are permanent and keep being
-- stamped solely by the trigger (re-pinning must not reorder the pin list).
--
-- Signature is unchanged from 0007, so this is a plain CREATE OR REPLACE
-- (grants preserved). Everything else (visibility gate, optimistic-concurrency
-- base-version check) is copied verbatim from 0007.

create or replace function public.set_item_state(
  p_item_id      uuid,
  p_pinned       boolean default null,
  p_favorite     boolean default null,
  p_done         boolean default null,
  p_hidden       boolean default null,
  p_opened       boolean default null,
  p_base_version bigint  default null
)
returns public.item_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.item_state;
  v_cur bigint;
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

  -- Optimistic concurrency: apply only if the row is still at the version the
  -- caller's queued change was based on (see 0007 for the full rationale and the
  -- base-0 first-insert race handling).
  if p_base_version is not null then
    select version into v_cur
    from public.item_state
    where user_id = v_uid and item_id = p_item_id
    for update;

    if coalesce(v_cur, 0) <> p_base_version then
      raise exception
        'item_state % changed since version % (server at %)',
        p_item_id, p_base_version, coalesce(v_cur, 0)
        using errcode = '40001';
    end if;
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
    opened   = coalesce(p_opened,   st.opened),
    -- Re-stamp the TTL'd flags so an explicit true write refreshes the 30-day
    -- window even when the raw row is already true-but-expired (the trigger
    -- only stamps on a real not-old→true transition). NULL param = untouched =
    -- keep the existing timestamp; false = clear (the trigger agrees).
    done_at   = case when p_done   is true  then now()
                     when p_done   is false then null
                     else st.done_at   end,
    hidden_at = case when p_hidden is true  then now()
                     when p_hidden is false then null
                     else st.hidden_at end,
    opened_at = case when p_opened is true  then now()
                     when p_opened is false then null
                     else st.opened_at end
  -- NULL base → no check (version = version, always true).
  where st.version = coalesce(p_base_version, st.version)
  returning st.* into v_row;

  if not found then
    -- A concurrent writer won the row between our check and the upsert (the
    -- base-0 first-insert race); reject so the loser reconciles.
    raise exception
      'item_state % changed concurrently (base %)', p_item_id, p_base_version
      using errcode = '40001';
  end if;

  return v_row;
end;
$$;

comment on function public.set_item_state(
  uuid, boolean, boolean, boolean, boolean, boolean, bigint
) is
  'Client item_state write path (upsert) with optimistic concurrency. Gates on '
  'current item visibility, then applies the write only if p_base_version '
  'matches the row''s current server version (NULL = skip check, 0 = expect no '
  'row), else raises 40001. Explicit true writes to the TTL''d flags '
  '(done/hidden/opened) refresh their *_at, so re-dismissing an item whose flag '
  'had expired restarts its 30-day window instead of resurfacing. See SPEC.md Sync.';
