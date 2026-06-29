-- Dark-mode favicon inversion hint.
--
-- Some publishers ship a black-on-transparent favicon (a dark monochrome mark)
-- that vanishes on the reader's dark page background. The client inverts such
-- icons to white in dark mode. Rather than hand-maintain the affected-domain
-- list forever, the poller now MEASURES each favicon once (decode → check how
-- much is transparent and whether the visible ink is dark + low-saturation; see
-- _shared/faviconDarkness.ts) and stores the verdict here. The client reads it
-- and keeps a small manual domain list as an override for icons the poller
-- can't decode (SVG, exotic formats).
--
-- Tri-state: true = invert, false = measured-not-dark, null = not yet measured
-- / undecodable. Like `favicon_url` (0036) this is plain display metadata — a
-- boolean about a public icon, no token-leak risk — so it is exposed to clients
-- via feeds_public (the fetch URLs url/secret_url stay server-only).

alter table public.feeds
  add column if not exists favicon_invert_dark boolean;

-- Expose to clients alongside the other display-safe columns (see 0002_rls.sql
-- §1 — table SELECT is revoked then granted back column-by-column, so a new
-- column is invisible until granted here).
grant select (favicon_invert_dark) on public.feeds to anon, authenticated;

-- Re-project the display-safe view to carry the new flag. security_invoker
-- stays on, so the same subscription/permanent-state RLS visibility applies;
-- the fetch URLs remain structurally omitted. CREATE OR REPLACE can only APPEND
-- view columns (never reorder/rename), so favicon_invert_dark goes last.
create or replace view public.feeds_public
  with (security_invoker = on) as
  select
    id, site_url, title,
    last_fetched_at, next_fetch_at, fetch_interval_s,
    error_count, last_error, created_at,
    favicon_url, favicon_invert_dark
  from public.feeds;
