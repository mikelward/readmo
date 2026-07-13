-- Per-account reading-behavior settings (SPEC.md *Settings* → scope): one row
-- per user, one nullable column per setting; NULL = "not set", the client
-- default applies. Appearance (theme/palette/text size/font), the bottom-
-- toolbar position, the app-wide article-layout default, and diagnostics stay
-- device-local by design — they're screen/device ergonomics, not account
-- intent — so they have no columns here.
--
-- The client (lib/settingsSync) reads the row on boot/focus/online and upserts
-- ONLY the columns that changed, so cross-device conflicts resolve last-write-
-- wins per setting: two devices flipping different toggles never clobber each
-- other, and flipping the same toggle resolves to the later write.
--
-- `user_id` defaults to auth.uid(), so the client payload carries no identity
-- column; RLS pins every row to its owner and fails closed (guardrail #7).
--
-- Backwards compatible (guardrail #11): additive. A new client feature-detects
-- a backend without this table (PGRST205) and keeps prefs device-local until
-- the deploy lands; an old cached client never touches the table. Goes live
-- via `make migrate`.

create table if not exists public.user_settings (
  user_id uuid primary key default auth.uid()
    references auth.users (id) on delete cascade,
  item_sort text check (item_sort in ('newest', 'oldest')),
  group_by_feed boolean,
  hide_on_scroll boolean,
  show_row_favicon boolean,
  show_group_favicon boolean,
  hide_sports_spoilers boolean,
  auto_summarize_pinned boolean,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy user_settings_select on public.user_settings
  for select using (user_id = auth.uid());
create policy user_settings_insert on public.user_settings
  for insert with check (user_id = auth.uid());
create policy user_settings_update on public.user_settings
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No DELETE policy: there's no "reset all" surface, and a deleted account's
-- row dies with the user via the FK cascade.

-- Deterministic grants (don't lean on the schema's defaults): signed-in
-- clients read and merge their own row; anon gets nothing.
revoke all on public.user_settings from public, anon, authenticated;
grant select, insert, update on public.user_settings to authenticated;

-- Record the row's last write (observability only — the client never reads it;
-- per-setting conflict resolution is the column-scoped upsert above).
create or replace function public.user_settings_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_settings_touch
  before update on public.user_settings
  for each row execute function public.user_settings_touch();
