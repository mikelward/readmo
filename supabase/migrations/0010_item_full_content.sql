-- Readmo full-text (reading-mode) cache.
--
-- Many feeds carry only a truncated stub as their item body. The `fulltext`
-- Edge Function fetches the article's own page (via the SSRF-hardened helper),
-- extracts the main article with Readability, sanitizes it, and caches the
-- result here so subsequent opens — on any of the user's devices, and for any
-- other subscriber to the same shared item — are served instantly without a
-- re-fetch. SPEC.md "Reader view" / "Full-text reading mode".
--
-- These columns sit on the SHARED `items` row (like `content_html`): the
-- extracted body is public article content under the same trust model, so one
-- subscriber's fetch benefits every subscriber. Visibility is unchanged — the
-- items_select RLS policy (0002) still gates which rows a caller can read, and
-- `grant select on items` (0008) is table-level, so the new columns are
-- readable by exactly the callers who could already see the row. Writes remain
-- server-only: 0002 revoked client INSERT/UPDATE on items and the function
-- writes as the service role (granted UPDATE in 0009).

alter table public.items
  -- SANITIZED extracted article HTML only — the fulltext function runs
  -- sanitizeContent() before writing, exactly like content_html. NULL until a
  -- successful extraction has been cached.
  add column if not exists full_content_html      text,
  -- When the extraction was last cached, so a future job can re-fetch stale
  -- entries or distinguish "never tried" (null) from "tried" if we later cache
  -- failures too. Currently only set on success.
  add column if not exists full_content_fetched_at timestamptz;
