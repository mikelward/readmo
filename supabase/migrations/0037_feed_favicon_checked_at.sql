-- Favicon HTML-lookup bookkeeping.
--
-- When a feed advertises no icon, the poller looks the icon up in the site's
-- HTML (<link rel="icon">) before settling for the /favicon.ico guess. This
-- column records WHEN that HTML lookup last ran so the result — including a
-- negative one (no usable icon / only /favicon.ico) — is cached: the poller
-- re-checks only when this is null (never looked) or older than its recheck
-- window, instead of re-fetching the homepage on every poll. Server-only
-- bookkeeping (poller/refresh, service role) — NOT exposed via feeds_public,
-- so it gets no client grant.

alter table public.feeds
  add column if not exists favicon_checked_at timestamptz;
