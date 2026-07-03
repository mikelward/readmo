-- Admin feed deletion for the /admin/feeds console.
--
-- The operator console lists every system feed, so it offers a per-feed Delete.
-- Deleting a feed is a system-wide, destructive operation (it's the SHARED
-- feed row, not a per-user subscription), so it's an admin-gated RPC — the same
-- `is_admin()` fail-closed pattern as every other admin RPC (0028/0029/0030).
--
-- A single `delete from feeds` cascades cleanly via the existing FKs:
--   - items.feed_id → feeds ON DELETE CASCADE (0001) removes the feed's items,
--     which in turn cascade to item_state.item_id and item_fulltext_status.item_id
--     (both ON DELETE CASCADE), so no orphaned per-user or attempt rows remain;
--   - subscriptions.feed_id → feeds ON DELETE CASCADE (0001) drops every user's
--     subscription to the feed.
-- Irreversible — the reader UI confirms before calling this.

create or replace function public.admin_delete_feed(p_feed_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  delete from public.feeds where id = p_feed_id;
end;
$$;

comment on function public.admin_delete_feed(uuid) is
  'Admin-only (is_admin) hard-delete of a shared feed for /admin/feeds: removes '
  'the feed and — via ON DELETE CASCADE — its items (and their item_state / '
  'item_fulltext_status rows) and every user''s subscription to it. Irreversible. '
  'Fails closed for non-admins (42501).';

revoke execute on function public.admin_delete_feed(uuid) from public;
grant  execute on function public.admin_delete_feed(uuid) to authenticated;
