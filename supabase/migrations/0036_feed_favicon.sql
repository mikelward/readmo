-- Feed favicon support.
--
-- Adds a display-safe `favicon_url` to feeds so the client can show a site's
-- favicon next to its name (in item rows and the group-by-feed header). The
-- poller derives this from the feed body (Atom <icon>/<logo>, RSS <image>,
-- JSON Feed favicon/icon) or the site origin's /favicon.ico, and writes it on
-- each poll. It is plain feed metadata like `title`/`site_url` — a public
-- http(s) image URL with no token-leak risk — so it is exposed to clients
-- (unlike the fetch URLs `url`/`secret_url`, which stay server-only).

alter table public.feeds
  add column if not exists favicon_url text;

-- Expose the new column to clients alongside the other display-safe columns
-- (see 0002_rls.sql §1 — table-level SELECT is revoked, then granted back
-- column-by-column, so a new column is invisible until granted here).
grant select (favicon_url) on public.feeds to anon, authenticated;

-- Re-project the display-safe view to carry the favicon too. security_invoker
-- stays on, so the same subscription/permanent-state RLS visibility applies;
-- the fetch URLs remain structurally omitted. CREATE OR REPLACE can only
-- APPEND view columns (never reorder/rename), so favicon_url goes last.
create or replace view public.feeds_public
  with (security_invoker = on) as
  select
    id, site_url, title,
    last_fetched_at, next_fetch_at, fetch_interval_s,
    error_count, last_error, created_at,
    favicon_url
  from public.feeds;
