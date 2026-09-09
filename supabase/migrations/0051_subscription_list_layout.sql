-- Per-feed "card style" (article row layout) preference.
--
-- A per-user subscription setting (alongside open_original / open_newshacker /
-- mark_done_on_open / title_override / muted / sort): how much of each of that
-- feed's articles a row shows — 'title' (compact title-only), 'thumbnail-small',
-- 'thumbnail', or 'excerpt'. NULL means "use the app-wide Article layout setting"
-- (the per-device `readmo:list-layout` default), so a feed only carries a value
-- once the user picks a per-feed override. SPEC.md "Article layout (card size) →
-- Per-feed override". Stored on `subscriptions` so it syncs across the user's
-- devices, like mute, rename, and the open-mode columns.
--
-- The four allowed values mirror the client `ListLayout` union (src/lib/types.ts);
-- the CHECK keeps a hand-crafted write from storing an unknown style the client
-- would have to defensively re-default anyway.

alter table public.subscriptions
  add column if not exists list_layout text
    check (list_layout in ('title', 'thumbnail-small', 'thumbnail', 'excerpt'));

comment on column public.subscriptions.list_layout is
  'Per-user: this feed''s article-row card style — title / thumbnail-small / '
  'thumbnail / excerpt. NULL = use the app-wide Article layout setting. '
  'SPEC.md "Article layout (card size)".';

-- Extend the column-scoped UPDATE grant (0004/0027/0034/0037) to the new display
-- column. The key columns (user_id, feed_id) stay un-grantable so a client can't
-- repoint a row to escalate access; list_layout is a harmless display
-- preference, so it joins folder / title_override / muted / sort / open_original
-- / open_newshacker / mark_done_on_open. Column grants are additive, so this only
-- needs to name the new column.
grant update (list_layout) on public.subscriptions to authenticated;
