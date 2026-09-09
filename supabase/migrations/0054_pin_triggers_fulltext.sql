-- Pin trigger v2: a pin also downloads the full source article.
--
-- 0053 made a committed pin fire the `summary` Edge Function so the AI summary
-- generates server-side, surviving the app closing right after the pin. The
-- full-text download had the same client-lifecycle hole: the pinned prefetch
-- (useOfflineCacheLock) fetches the reading-mode extraction from the device,
-- and dies with the page just like the summary pre-warm did. The summary
-- function's pin-triggered work now downloads the full article FIRST (one
-- internal call to `fulltext` — truncation-gated there, mirroring the client's
-- pinned prefetch) and then generates the summary, so this migration only has
-- to widen the trigger's skip condition: fire when EITHER artifact is missing,
-- not just the summary. Everything else (Vault config, fire-and-forget pg_net
-- post, allowlist enforcement in the function) is unchanged from 0053.
--
-- Note the function-side allowlist gate this posts into is REQUIRED for
-- server-initiated work: an empty allowlist means the trigger works for no
-- one (isInternalCallerAllowed — the poller's cost-guard convention), so this
-- trigger can never spend Jina/Gemini/publisher fetches before the operator
-- seeds the list.

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
  -- Only a pin turning ON — not unpins, not other state fields (the upsert in
  -- set_item_state always includes `pinned` in its SET list, so filter on the
  -- actual transition).
  if not new.pinned then return new; end if;
  if tg_op = 'UPDATE' and old.pinned then return new; end if;

  -- Both artifacts already cached (shared, on the item) -> nothing to do. A
  -- missing full_content_html alone still fires: the function applies the
  -- truncation gate (a complete feed body fetches nothing), so this stays a
  -- cheap no-op for complete-body re-pins rather than a wrong skip for
  -- truncated ones.
  if exists (
    select 1 from public.items i
    where i.id = new.item_id
      and i.ai_summary is not null
      and i.full_content_html is not null
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
  'AFTER trigger on item_state: when a pin lands, fire-and-forget the summary '
  'Edge Function via pg_net, which downloads the full article (truncation-'
  'gated) and generates the AI summary server-side — both survive the client '
  'closing right after the pin. Allowlist members only (empty list = no one). '
  'No-ops when Vault is unconfigured, when the pin is not a false->true '
  'transition, or when the item already has both artifacts cached. See '
  'SPEC.md AI article summaries.';
