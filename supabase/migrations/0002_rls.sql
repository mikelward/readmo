-- Readmo Row-Level Security.
--
-- SPEC.md "RLS — reads scoped to the caller; feeds/items are NOT
-- world-readable" + guardrail #7. The per-user tables gate on auth.uid(); the
-- shared feeds/items tables expose a row only to callers who either subscribe
-- to the feed OR hold a PERMANENT (pinned/favorite/done) item_state row
-- against the item. The poller uses the service role, which BYPASSES RLS, so
-- it can read secret_url and write everywhere.
--
-- Fail-closed posture: enabling RLS with no policy denies all access; every
-- table below gets explicit policies.

-- ---------------------------------------------------------------------------
-- Enable RLS on every table. (Service role bypasses these entirely.)
-- ---------------------------------------------------------------------------
alter table public.feeds         enable row level security;
alter table public.items         enable row level security;
alter table public.subscriptions enable row level security;
alter table public.item_state    enable row level security;
alter table public.folders       enable row level security;

-- ===========================================================================
-- subscriptions — readable/writable only by the owning user.
-- ===========================================================================
create policy subscriptions_select on public.subscriptions
  for select using (user_id = auth.uid());
create policy subscriptions_insert on public.subscriptions
  for insert with check (user_id = auth.uid());
create policy subscriptions_update on public.subscriptions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy subscriptions_delete on public.subscriptions
  for delete using (user_id = auth.uid());

-- ===========================================================================
-- item_state — readable/writable only by the owning user. (The `version`
-- column is server-assigned by a trigger; see 0003. Clients may set the
-- boolean/timestamp fields.)
-- ===========================================================================
create policy item_state_select on public.item_state
  for select using (user_id = auth.uid());
create policy item_state_insert on public.item_state
  for insert with check (user_id = auth.uid());
create policy item_state_update on public.item_state
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy item_state_delete on public.item_state
  for delete using (user_id = auth.uid());

-- ===========================================================================
-- folders — readable/writable only by the owning user.
-- ===========================================================================
create policy folders_select on public.folders
  for select using (user_id = auth.uid());
create policy folders_insert on public.folders
  for insert with check (user_id = auth.uid());
create policy folders_update on public.folders
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy folders_delete on public.folders
  for delete using (user_id = auth.uid());

-- ===========================================================================
-- feeds — shared storage, NOT world-readable. A signed-in user may read a
-- feed row only when:
--   (a) they have a matching subscription, OR
--   (b) they hold a PERMANENT item_state row (pinned/favorite/done) on an item
--       belonging to this feed — so unsubscribing never orphans a kept item.
-- Hidden/Opened are TTL'd and get NO exemption.
--
-- Clients never INSERT/UPDATE/DELETE feeds directly (the poller / an
-- "add feed" RPC running as service role does that), so we grant SELECT only.
-- ===========================================================================
create policy feeds_select on public.feeds
  for select using (
    exists (
      select 1 from public.subscriptions s
      where s.feed_id = feeds.id
        and s.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.item_state st
      join public.items i on i.id = st.item_id
      where i.feed_id = feeds.id
        and st.user_id = auth.uid()
        and (st.pinned or st.favorite or st.done)
    )
  );

-- ===========================================================================
-- items — same visibility test as feeds, applied per item:
--   (a) the caller subscribes to the item's parent feed, OR
--   (b) the caller holds a permanent item_state row on THIS item.
-- ===========================================================================
create policy items_select on public.items
  for select using (
    exists (
      select 1 from public.subscriptions s
      where s.feed_id = items.feed_id
        and s.user_id = auth.uid()
    )
    or exists (
      select 1 from public.item_state st
      where st.item_id = items.id
        and st.user_id = auth.uid()
        and (st.pinned or st.favorite or st.done)
    )
  );

-- ===========================================================================
-- Keep secret_url server-only. RLS controls ROW visibility but not COLUMN
-- visibility, so even a visible feeds row would otherwise leak secret_url to
-- the anon/authenticated roles. Two-part defense:
--   1. Revoke column-level access to secret_url from client roles.
--   2. Expose a display-safe view `feeds_public` that omits secret_url for
--      clients to read through.
-- The service role (poller) retains full table access and reads secret_url.
-- ===========================================================================

-- 1. Revoke the secret column from the client-facing roles. (They keep access
--    to the other columns via the table's RLS SELECT policy above.)
revoke select (secret_url) on public.feeds from anon, authenticated;
-- Defensive: clients never write feeds, so revoke write entirely.
revoke insert, update, delete on public.feeds from anon, authenticated;
revoke insert, update, delete on public.items from anon, authenticated;

-- 2. A display-safe view. security_invoker=on makes the view honor the
--    querying user's RLS on the underlying feeds table (so the same
--    subscription/permanent-state visibility applies), while structurally
--    omitting secret_url.
create or replace view public.feeds_public
  with (security_invoker = on) as
  select
    id, url, site_url, title,
    last_fetched_at, next_fetch_at, fetch_interval_s,
    error_count, last_error, created_at
  from public.feeds;

comment on view public.feeds_public is
  'Display-safe projection of feeds for clients. Omits secret_url; honors the '
  'caller''s RLS via security_invoker. The poller (service role) reads '
  'public.feeds directly for secret_url.';
