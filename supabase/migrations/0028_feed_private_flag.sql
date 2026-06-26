-- 0028: Expose a display-safe `private` flag so the client can fail closed on
-- private (secret_url-backed) feeds without ever seeing the secret URL itself.
--
-- The reader's HN-discussion lookup forwards the article URL to a third party
-- (HN's Algolia index). For a private/tokenized feed that would leak which
-- members-only article a user is reading, so the client must skip the lookup
-- for private feeds (guardrail #6/#7) — mirroring the full-text path's
-- feed-level secret_url gate. But `feeds_public` is security_invoker=on and the
-- client has no SELECT on `secret_url`, so it cannot derive privacy itself.
--
-- Solution: a generated STORED column computes `private = secret_url is not
-- null` at write time (evaluated as the table owner, so it doesn't require the
-- caller to read secret_url), and we grant SELECT on just that boolean. The
-- fetch URLs stay server-only; only the derived bit is exposed. Additive
-- (guardrail #11): old clients ignore the new column; new clients fail closed
-- (treat an absent flag as private) until this migration is deployed.

alter table public.feeds
  add column if not exists private boolean
  generated always as (secret_url is not null) stored;

grant select (private) on public.feeds to anon, authenticated;

-- Re-create the display-safe view to surface the derived flag (still omitting
-- both fetch URLs). The new column is appended after the existing list so
-- `create or replace view` accepts the change.
create or replace view public.feeds_public
  with (security_invoker = on) as
  select
    id, site_url, title,
    last_fetched_at, next_fetch_at, fetch_interval_s,
    error_count, last_error, created_at,
    private
  from public.feeds;

comment on view public.feeds_public is
  'Display-safe projection of feeds for clients. Omits the fetch URLs '
  '(url + secret_url), which may embed per-user tokens; honors the caller''s '
  'RLS via security_invoker. Exposes a derived `private` flag '
  '(secret_url is not null) so clients can fail closed on private feeds '
  'without reading the secret. The poller (service role) reads public.feeds '
  'directly for the fetch URLs.';
