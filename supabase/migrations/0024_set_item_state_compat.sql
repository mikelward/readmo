-- Readmo item_state: deploy-window compatibility shim for old service-worker-
-- cached clients during the LWW cutover (0023).
--
-- Background. 0023 replaced the server-`version` write path with per-field
-- last-write-wins and dropped the `p_base_version` argument. But a PWA client
-- cached before that deploy still calls `set_item_state` with `p_base_version`
-- (and WITHOUT the new `p_<f>_at` timestamps). Against the 0023 signature those
-- calls fail to resolve (PostgREST 404 PGRST202), and because the client's outbox
-- treats anything but 42501 as transient, every triage write retries forever and
-- never lands until the user reloads into the new bundle.
--
-- This shim makes those old-shape writes resolve and APPLY, two-user app, so the
-- cutover (deploy backend, then both users reload) has no write-loss window:
--   1. Re-add a trailing `p_base_version bigint default null` parameter that is
--      ACCEPTED AND IGNORED — purely so an old call's argument set resolves to
--      this one function. (We DROP the 0023 11-arg signature first so there's a
--      single canonical overload and no ambiguous-candidate error for new calls.)
--   2. Treat a missing per-field timestamp as "now": an old client sends the flag
--      but no `p_<f>_at`, so `coalesce(p_<f>_at, now())` stamps the action at write
--      time and it wins LWW like any current edit. New clients always send a real
--      `at`, so coalesce is the identity for them — no behavior change.
--
-- SCOPE — writes only. An old cached client's item_state *read* still selects the
-- dropped `version` column, so its cross-device flag hydration 400s and silently
-- degrades (stale sync) until it reloads; the feed itself is unaffected
-- (`feed_items` never selected `version`). Fully bridging reads would mean
-- re-adding the `version` column — the back-compat machinery 0023 deliberately
-- removed — so this shim deliberately covers only the write path. Drop this shim
-- (restore the 0023 signature) once no pre-0023 client remains.

-- Single canonical overload: drop the 0023 11-arg signature before recreating.
drop function if exists public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz
);

create or replace function public.set_item_state(
  p_item_id     uuid,
  p_pinned      boolean     default null,
  p_pinned_at   timestamptz default null,
  p_favorite    boolean     default null,
  p_favorite_at timestamptz default null,
  p_done        boolean     default null,
  p_done_at     timestamptz default null,
  p_hidden      boolean     default null,
  p_hidden_at   timestamptz default null,
  p_opened      boolean     default null,
  p_opened_at   timestamptz default null,
  p_base_version bigint     default null  -- accepted and ignored (compat shim)
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

  -- Lock any existing row so concurrent writers serialize on its timestamps.
  perform 1 from public.item_state
   where user_id = v_uid and item_id = p_item_id
   for update;

  insert into public.item_state as st
    (user_id, item_id,
     pinned, pinned_at, favorite, favorite_at,
     done, done_at, hidden, hidden_at, opened, opened_at)
  values (
    v_uid, p_item_id,
    coalesce(p_pinned, false),   case when p_pinned   is not null then coalesce(p_pinned_at,   now()) end,
    coalesce(p_favorite, false), case when p_favorite is not null then coalesce(p_favorite_at, now()) end,
    coalesce(p_done, false),     case when p_done     is not null then coalesce(p_done_at,     now()) end,
    coalesce(p_hidden, false),   case when p_hidden   is not null then coalesce(p_hidden_at,   now()) end,
    coalesce(p_opened, false),   case when p_opened   is not null then coalesce(p_opened_at,   now()) end
  )
  on conflict (user_id, item_id) do update set
    -- Per-field LWW: apply the incoming value only when supplied AND its action
    -- time (the sent `p_<f>_at`, or `now()` for an old client that sent none) is
    -- at least the stored field's last-change time. Record that time as the new
    -- last-change clock.
    pinned = case when p_pinned is not null
                   and (st.pinned_at is null or coalesce(p_pinned_at, now()) >= st.pinned_at)
                  then p_pinned else st.pinned end,
    pinned_at = case when p_pinned is not null
                   and (st.pinned_at is null or coalesce(p_pinned_at, now()) >= st.pinned_at)
                  then coalesce(p_pinned_at, now()) else st.pinned_at end,
    favorite = case when p_favorite is not null
                   and (st.favorite_at is null or coalesce(p_favorite_at, now()) >= st.favorite_at)
                  then p_favorite else st.favorite end,
    favorite_at = case when p_favorite is not null
                   and (st.favorite_at is null or coalesce(p_favorite_at, now()) >= st.favorite_at)
                  then coalesce(p_favorite_at, now()) else st.favorite_at end,
    done = case when p_done is not null
                   and (st.done_at is null or coalesce(p_done_at, now()) >= st.done_at)
                  then p_done else st.done end,
    done_at = case when p_done is not null
                   and (st.done_at is null or coalesce(p_done_at, now()) >= st.done_at)
                  then coalesce(p_done_at, now()) else st.done_at end,
    hidden = case when p_hidden is not null
                   and (st.hidden_at is null or coalesce(p_hidden_at, now()) >= st.hidden_at)
                  then p_hidden else st.hidden end,
    hidden_at = case when p_hidden is not null
                   and (st.hidden_at is null or coalesce(p_hidden_at, now()) >= st.hidden_at)
                  then coalesce(p_hidden_at, now()) else st.hidden_at end,
    opened = case when p_opened is not null
                   and (st.opened_at is null or coalesce(p_opened_at, now()) >= st.opened_at)
                  then p_opened else st.opened end,
    opened_at = case when p_opened is not null
                   and (st.opened_at is null or coalesce(p_opened_at, now()) >= st.opened_at)
                  then coalesce(p_opened_at, now()) else st.opened_at end
  returning st.* into v_row;

  return v_row;
end;
$$;

comment on function public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz, bigint
) is
  'Client item_state write path (upsert) with per-field last-write-wins. '
  'Compat shim (0024): accepts and ignores a trailing p_base_version so a '
  'pre-0023 cached client''s write still resolves, and treats a missing '
  'p_<f>_at as now() so that write applies. Gates on current item visibility. '
  'See SPEC.md Sync.';

-- Definer functions default to EXECUTE for PUBLIC; restrict to signed-in users.
revoke execute on function public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz, bigint
) from public;
grant execute on function public.set_item_state(
  uuid, boolean, timestamptz, boolean, timestamptz, boolean, timestamptz,
  boolean, timestamptz, boolean, timestamptz, bigint
) to authenticated;
