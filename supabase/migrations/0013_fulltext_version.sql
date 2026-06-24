-- Readmo full-text cache: extractor-version stamp for lazy invalidation.
--
-- 0010 added items.full_content_html (the cached reading-mode body) with no way
-- to invalidate it: the `fulltext` function serves any non-null body as-is, so a
-- body cached by older extraction code is served forever — e.g. articles cached
-- before the title-duplicate-heading strip (commit a64b20d) keep showing the
-- headline twice. The cache is per shared item and effectively permanent.
--
-- Fix: stamp each cache write with the version of the extraction pipeline that
-- produced it. The function only treats a body as a cache hit when its stamp
-- equals the current FULLTEXT_VERSION (supabase/functions/_shared/fulltext.ts);
-- a mismatch re-extracts with current code and re-stamps. Bumping that constant
-- when extraction output changes therefore lazily corrects already-cached rows
-- on their next open, with no data migration or re-fetch storm.
--
-- NULL is the legacy value: every row cached before this column existed reads as
-- "no current stamp" and re-extracts on next open, which is exactly the fix for
-- the duplicated-header bug. No backfill needed. The column sits on the SHARED
-- items row alongside full_content_html under the same trust model (0010): the
-- items_select RLS policy (0002) still gates visibility, writes stay server-only
-- (client item writes revoked in 0002; service role granted UPDATE in 0009).

alter table public.items
  -- Version of the extraction pipeline that wrote full_content_html. NULL =
  -- cached before versioning (legacy) → stale, re-extract. Set by the fulltext
  -- function to FULLTEXT_VERSION on every successful cache write.
  add column if not exists full_content_version int;
