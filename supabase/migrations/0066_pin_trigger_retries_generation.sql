-- Pin trigger v3: let it RETRY a failed/late generation, not only fire once.
--
-- 0053/0054 fire the `summary` Edge Function from the DB when a pin commits, so
-- the AI summary (and full article) generate server-side even if the app closes
-- right after the pin. But the trigger only fired on the pinned FALSE->TRUE edge:
--
--   if not new.pinned then return new; end if;
--   if tg_op = 'UPDATE' and old.pinned then return new; end if;   -- <- dropped here
--
-- That edge happens exactly once per pin. So if the one kick-off it produced
-- didn't land the artifacts — the backend was down / Vault unconfigured / the
-- allowlist wasn't seeded at pin time, or the background Jina/Gemini work failed
-- transiently — nothing server-side ever tried again. The item stays pinned but
-- unsummarized, and only a later client on-open (app open AND online AND
-- allowlisted) could recover it. A pinned article the user never reopens online
-- silently never gets its summary. That's the "summarize on pin still not
-- working reliably" tail.
--
-- We DROP the false->true edge guard and let the trigger re-attempt on ANY
-- insert/update of a pinned row that still has work left, then widen 0054's skip
-- so it recognizes when there IS no work left. 0054 skipped only when BOTH
-- `ai_summary` AND `full_content_html` were cached — but a complete-body article
-- never caches `full_content_html` (the fulltext path fetches nothing for a
-- non-truncated body), so keeping that condition would re-post such a pin on
-- every later state write forever once the edge guard is gone. So the skip now
-- also treats a complete (non-truncated) feed body as "full text done". Any
-- later state write to a still-unsummarized pinned item (mark done, mark opened,
-- a reverse-sync touch) re-kicks generation, giving the server side the retry it
-- lacked, while a finished pin stays quiet.
--
-- Why this stays cheap (guardrail #5):
--   * A pin with its summary cached and its full text cached-or-not-needed
--     short-circuits on the skip below — no HTTP post — so the common case (pin,
--     get summarized, keep using the item) costs nothing extra. Only a pinned
--     item that still has an obtainable artifact missing re-posts, which is
--     precisely when a retry is wanted.
--   * The function re-checks the allowlist and the pin row before spending
--     anything, and the generation lease (`_shared/summary.ts`) collapses any
--     burst of re-kicks for the same item into a single Gemini call — a redundant
--     post is cheaply declined or coalesced, never a duplicate generation.
--   * `net.http_post` stays async/fire-and-forget and exception-wrapped, so a
--     retry can never block, delay, or roll back the state write that fired it.
--
-- Function body is otherwise VERBATIM from 0054 (Vault lookup, allowlist-gated
-- fire-and-forget post). The trigger itself (on_item_pinned_summary, INSERT OR
-- UPDATE) is unchanged, so this is a create-or-replace of the function only.

create or replace function public.handle_item_pinned_summary()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_key text;
  v_base_url    text;
  v_email       text;
begin
  -- Only while the item is pinned. Unlike 0053/0054 this no longer requires a
  -- false->true transition: a pinned row that is still missing an artifact should
  -- re-attempt on any write, so a generation that failed the first time is
  -- retried rather than stranded. The skip below keeps a FINISHED pin (summary
  -- cached, full text cached or not needed) from posting, so re-firing on
  -- unrelated state changes to a complete pin costs nothing.
  if not new.pinned then return new; end if;

  -- Skip when no work is left that could ever succeed:
  --   * the AI summary is cached, AND
  --   * the full article is cached OR will NEVER be cached because the feed body
  --     is already the complete article (not a truncated stub). The fulltext path
  --     deliberately fetches/caches nothing for a complete body (fulltext/index.ts
  --     — `!looksTruncatedHtml` returns `empty` without writing full_content_html),
  --     so requiring `full_content_html is not null` there would re-kick such a pin
  --     on EVERY later state write forever now that the false->true edge guard is
  --     gone. So treat a complete feed body as "full text done" too.
  --
  -- The truncation test mirrors the client / summary path's
  -- SUMMARY_TRUNCATION_TEXT_THRESHOLD (`looksTruncatedHtml`): visible-text length
  -- < 600 = a stub. Kept a conservative approximation of `htmlTextLength` (strip
  -- tags + entities, collapse whitespace, trim); if it ever drifts from the TS
  -- constant it only changes how eagerly a borderline body is re-tried for full
  -- text, never correctness (the summary is already cached by the time it matters,
  -- and fulltext re-applies the real gate on any kick this lets through). While
  -- the summary itself is missing, this whole check is false and the trigger fires
  -- regardless — that is the summary retry.
  if exists (
    select 1 from public.items i
    where i.id = new.item_id
      and i.ai_summary is not null
      and (
        i.full_content_html is not null
        or length(trim(
             regexp_replace(
               regexp_replace(
                 regexp_replace(coalesce(i.content_html, ''), '<[^>]*>', ' ', 'g'),
                 '&[a-z#0-9]+;', ' ', 'gi'),
               '\s+', ' ', 'g')
           )) >= 600
      )
  ) then
    return new;
  end if;

  -- Vault lookups: the functions base URL and the bearer the function trusts.
  select decrypted_secret into v_service_key
    from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'functions_base_url';

  -- Not configured yet -> do nothing, but never break the state write.
  if v_service_key is null or v_base_url is null then
    return new;
  end if;

  -- The caller's email, for the (email-keyed) allowlist check server-side.
  select u.email into v_email from auth.users u where u.id = new.user_id;

  begin
    perform net.http_post(
      url     := rtrim(v_base_url, '/') || '/summary',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_service_key,
        'Content-Type', 'application/json'
      ),
      body    := jsonb_build_object(
        'itemId', new.item_id,
        'userId', new.user_id,
        'email', v_email
      ),
      -- The function answers the internal call fast (gates only; the
      -- fulltext + Gemini work continues in the background — see
      -- summary/index.ts), but give it headroom over pg_net's 5 s default so
      -- a slow cold start isn't aborted.
      timeout_milliseconds := 15000
    );
  exception when others then
    -- A kick-off failure must never roll back the pin itself.
    raise warning 'handle_item_pinned_summary: %', sqlerrm;
  end;

  return new;
end;
$$;

comment on function public.handle_item_pinned_summary() is
  'AFTER trigger on item_state: while an item is pinned and still missing the AI '
  'summary and/or full article, fire-and-forget the summary Edge Function via '
  'pg_net so generation happens server-side and is RETRIED on later state writes '
  'until both artifacts are cached (not just once on the pin edge). Allowlist '
  'members only (empty list = no one). No-ops when Vault is unconfigured, when '
  'the item is not pinned, or when the summary is cached and the full article '
  'is cached or not needed (a complete, non-truncated feed body). See '
  'SPEC.md AI article summaries.';
