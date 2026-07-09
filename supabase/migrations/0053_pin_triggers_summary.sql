-- Pinning an article triggers its AI summary generation SERVER-SIDE.
--
-- The client's `useSummaryPrewarm` fires the `summary` Edge Function the moment
-- an item is pinned, but it's inherently best-effort: pin an article and lock
-- the phone (or lose the network) a second later and the in-flight call dies
-- with the page, so the summary never generates and the eventual open falls
-- back to generating on demand — a spinner where the pre-warmed card should be.
-- The pin's server write is the one leg of that flow that reliably lands (the
-- outbox retries it), so hang the trigger there: when a pin commits to
-- `item_state`, post the item to the `summary` Edge Function from the database,
-- exactly like 0012's signup notifier. Generation then survives the app
-- closing; the client pre-warm remains as the device-cache warmer and retry
-- backstop. SPEC.md *AI article summaries*.
--
-- Design notes (mirrors 0012_signup_notification.sql):
--  * pg_net's net.http_post is ASYNC/fire-and-forget — it queues the request
--    and returns immediately, and queue inserts roll back with the transaction,
--    so a pin that doesn't commit never fires. A slow or failing summary call
--    can never block, delay, or roll back the state write; the post is also
--    wrapped in an exception handler as belt-and-suspenders.
--  * Config (the functions base URL + the service-role bearer) is read from
--    Vault (`functions_base_url`, `service_role_key` — SETUP.md §7a/§9b; both
--    already stored for the poller + signup notifier, so no new secret). If
--    EITHER is absent the trigger no-ops, so state sync keeps working before
--    the notifier is configured (and on any project where it isn't wanted).
--  * The function recognizes the internal call by the service-role bearer and
--    the `userId` in the body (see summary/index.ts). It re-checks the
--    allowlist against that user and verifies the pin row before spending
--    anything, so this trigger adds no access or cost surface: a non-allowlisted
--    user's pin costs one cheap, immediately-declined function call.
--  * Fires only when `pinned` turns ON, and only while the item has no cached
--    summary yet — a re-pin of an already-summarized article queues nothing.
--    Concurrent duplicates (this trigger racing the client pre-warm) collapse
--    into one Gemini call via the generation lease (_shared/summary.ts).

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

  -- Already summarized (shared cache on the item) -> nothing to generate.
  if exists (
    select 1 from public.items i
    where i.id = new.item_id and i.ai_summary is not null
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
      -- The function answers the internal call fast (gates only; generation
      -- continues in the background — see summary/index.ts), but give it
      -- headroom over pg_net's 5 s default so a slow cold start isn't aborted.
      timeout_milliseconds := 15000
    );
  exception when others then
    -- A summary kick-off failure must never roll back the pin itself.
    raise warning 'handle_item_pinned_summary: %', sqlerrm;
  end;

  return new;
end;
$$;

comment on function public.handle_item_pinned_summary() is
  'AFTER trigger on item_state: when a pin lands, fire-and-forget the summary '
  'Edge Function via pg_net so the AI summary generates server-side, surviving '
  'the client closing right after the pin. No-ops when Vault is unconfigured, '
  'when the pin is not a false->true transition, or when the item already has '
  'a cached summary. See SPEC.md AI article summaries.';

-- Re-runnable: drop then recreate so a re-applied migration stays idempotent.
drop trigger if exists on_item_pinned_summary on public.item_state;
create trigger on_item_pinned_summary
  after insert or update on public.item_state
  for each row execute function public.handle_item_pinned_summary();
