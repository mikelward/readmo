-- Per-feed "mark done when opening" preference.
--
-- A per-user subscription setting (alongside open_original / open_newshacker /
-- title_override / muted / sort): when on, opening one of that feed's items on
-- the original source website (open-original mode or the reader's Open-original
-- button) or the item's newshacker discussion (newshacker mode) also marks it
-- Done. Deliberately does NOT fire for an in-app reader (article view) open —
-- the setting is scoped to the outbound "open original / open on newshacker"
-- actions. Independent of the open-mode columns. SPEC.md "Mark done when
-- opening". Stored on `subscriptions` so it syncs across the user's devices, like
-- mute and rename.

alter table public.subscriptions
  add column if not exists mark_done_on_open boolean not null default false;

comment on column public.subscriptions.mark_done_on_open is
  'Per-user: when true, opening one of this feed''s items on the original source '
  'or the newshacker discussion (not the in-app reader) also marks it Done. '
  'SPEC.md "Mark done when opening".';

-- Extend the column-scoped UPDATE grant (0004/0027/0034) to the new display
-- column. The key columns (user_id, feed_id) stay un-grantable so a client can't
-- repoint a row to escalate access; mark_done_on_open is a harmless display
-- preference, so it joins folder / title_override / muted / sort / open_original
-- / open_newshacker. Column grants are additive, so this only needs to name the
-- new column.
grant update (mark_done_on_open) on public.subscriptions to authenticated;
