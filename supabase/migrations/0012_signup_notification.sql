-- Email the operator when a new user signs up.
--
-- Signups land as rows in `auth.users` (Supabase Auth, social OAuth). This adds
-- an AFTER INSERT trigger that posts the new row to the `notify-signup` Edge
-- Function, which sends the alert email over SMTP (see
-- supabase/functions/notify-signup + _shared/signupNotification.ts).
--
-- Design notes:
--  * pg_net's net.http_post is ASYNC/fire-and-forget — it queues the request
--    and returns immediately, so a slow or failing notifier can never block,
--    delay, or roll back account creation. The whole post is also wrapped in an
--    exception handler as belt-and-suspenders.
--  * Config (the function base URL + the service-role bearer the function
--    checks) is read from Vault, exactly like the cron poller (SETUP.md §7).
--    Both are server-only secrets; the client never sees them. If EITHER is
--    absent the trigger no-ops, so signups keep working before the notifier is
--    configured (and on any project where it isn't wanted).
--  * The function authorizes the call by comparing the bearer to the
--    service-role key itself (it deploys with --no-verify-jwt), matching `poll`.

create extension if not exists pg_net;

create or replace function public.handle_new_user_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_key text;
  v_base_url    text;
begin
  -- Vault lookups: the function's invoke URL and the bearer it expects. Stored
  -- once by the operator (SETUP.md). Names must match what's in Vault.
  select decrypted_secret into v_service_key
    from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'functions_base_url';

  -- Not configured yet -> do nothing, but never break the signup.
  if v_service_key is null or v_base_url is null then
    return new;
  end if;

  begin
    perform net.http_post(
      url     := rtrim(v_base_url, '/') || '/notify-signup',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_service_key,
        'Content-Type', 'application/json'
      ),
      body    := jsonb_build_object(
        'id', new.id,
        'email', new.email,
        'created_at', new.created_at
      )
    );
  exception when others then
    -- A notification failure must never roll back account creation.
    raise warning 'handle_new_user_notify: %', sqlerrm;
  end;

  return new;
end;
$$;

-- Re-runnable: drop then recreate so a re-applied migration stays idempotent.
drop trigger if exists on_auth_user_created_notify on auth.users;
create trigger on_auth_user_created_notify
  after insert on auth.users
  for each row execute function public.handle_new_user_notify();
