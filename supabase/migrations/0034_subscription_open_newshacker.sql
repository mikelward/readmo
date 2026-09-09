-- Per-feed "open on newshacker" preference (Hacker News feeds only).
--
-- A sibling of `open_original` (0027): a per-user subscription setting that, when
-- on, makes that feed's article rows open the item's Hacker News discussion on
-- newshacker.app (newshacker.app/item/<hn-id>) instead of the in-app reader. The
-- HN id is derived client-side from the item's HN comments link; the column only
-- stores the user's preference. Only offered for Hacker News feeds, but the
-- column is feed-agnostic. SPEC.md "Open original / Open on newshacker". Stored on
-- `subscriptions` so it syncs across the user's devices, like mute and rename.
--
-- The two columns are mutually exclusive in the UI (a single three-way choice:
-- Reader / Open original / Open on newshacker), but kept as independent booleans
-- so an older, service-worker-cached client that only knows `open_original` keeps
-- working: it reads open_original and falls back to the in-app reader for a feed
-- the newer client set to newshacker mode.

alter table public.subscriptions
  add column if not exists open_newshacker boolean not null default false;

comment on column public.subscriptions.open_newshacker is
  'Per-user: when true, this feed''s article rows open the item''s Hacker News '
  'discussion on newshacker.app instead of the in-app reader. Offered for '
  'Hacker News feeds only. SPEC.md "Open original / Open on newshacker".';

-- Extend the column-scoped UPDATE grant (0004/0027) to the new display column.
-- The key columns (user_id, feed_id) stay un-grantable so a client can't repoint
-- a row to escalate access; open_newshacker is a harmless display preference, so
-- it joins folder / title_override / muted / sort / open_original. Column grants
-- are additive, so this only needs to name the new column.
grant update (open_newshacker) on public.subscriptions to authenticated;
