-- Per-feed "open original" preference.
--
-- A new per-user subscription setting (alongside title_override / muted / sort):
-- when on, tapping any of that feed's article rows opens the original article on
-- the publisher's site directly (new tab) instead of Readmo's in-app reader.
-- SPEC.md "Open original". Stored on `subscriptions` so it syncs across the
-- user's devices, like mute and rename.

alter table public.subscriptions
  add column if not exists open_original boolean not null default false;

comment on column public.subscriptions.open_original is
  'Per-user: when true, this feed''s article rows open the original article on '
  'the source website directly (new tab) instead of the in-app reader. SPEC.md '
  '"Open original".';

-- Extend the column-scoped UPDATE grant (0004) to the new display column. The
-- key columns (user_id, feed_id) stay un-grantable so a client can't repoint a
-- row to escalate access; open_original is a harmless display preference, so it
-- joins folder / title_override / muted / sort. Column grants are additive, so
-- this only needs to name the new column.
grant update (open_original) on public.subscriptions to authenticated;
