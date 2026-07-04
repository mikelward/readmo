-- Link a Readmo account to a newshacker app token, so dismissing a Hacker News
-- story here mirrors to that user's newshacker "Done" list (SPEC.md "Mirror
-- dismissals to newshacker").
--
-- The token is a bearer credential the user mints in newshacker (Settings →
-- Connected apps) and pastes into Readmo once. It's SERVER-ONLY: the client
-- never reads it back. RLS is on with NO policy for `authenticated`, so the
-- table is reachable only by (a) the SECURITY DEFINER RPCs below — which set /
-- clear / test-existence scoped to `auth.uid()` and NEVER return the token —
-- and (b) the service_role (the `newshacker-sync` Edge Function), which reads
-- the token to forward the mirror call. Guardrail #7 (RLS is the boundary; the
-- client never gets the service-role key; secrets stay server-only).
--
-- TODO(security): encrypt the token at rest with Supabase Vault (pgsodium)
-- rather than storing it plaintext. It only grants access to the user's own
-- newshacker Done-list sync and is revocable from either side, so plaintext in
-- an RLS-locked, client-unreadable table is acceptable for now; tracked
-- alongside the B3 (OAuth-style linking) follow-up.

create table if not exists public.newshacker_link (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  token      text not null,
  created_at timestamptz not null default now()
);

alter table public.newshacker_link enable row level security;

-- No policies + no table grants → deny-all for anon/authenticated (fail closed).
-- Only the definer RPCs (which run as owner) and service_role touch the rows.
revoke all on public.newshacker_link from anon, authenticated;

-- The service role bypasses RLS but still needs table-level privileges (same as
-- feeds/items in 0009): the `newshacker-sync` Edge Function reads the token with
-- its service-role client. SELECT is enough — writes go through the definer RPCs
-- above, never the service client. Without this the mirror silently fails
-- (`.select('token')` → permission denied → every dismissal returns ok:false).
grant select on public.newshacker_link to service_role;

comment on table public.newshacker_link is
  'Per-user newshacker app token for mirroring dismissals to newshacker. '
  'Server-only (RLS deny-all; reached via the definer RPCs and service_role). '
  'SPEC.md "Mirror dismissals to newshacker".';

-- ---------------------------------------------------------------------------
-- Client-facing RPCs. Identity is always `auth.uid()`, never a parameter, so a
-- caller can only ever read/write their own link.
-- ---------------------------------------------------------------------------

-- Store (or replace) the caller's token. Validates the newshacker wire shape
-- (`nht_` + base64url) so an obviously-wrong paste is rejected before it ever
-- reaches the sync call. Never returns the token.
create or replace function public.set_newshacker_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := btrim(coalesce(p_token, ''));
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if v_token !~ '^nht_[A-Za-z0-9_-]{16,}$' then
    raise exception 'a valid newshacker token is required' using errcode = '22023';
  end if;
  insert into public.newshacker_link (user_id, token)
  values (auth.uid(), v_token)
  on conflict (user_id) do update set token = excluded.token, created_at = now();
end;
$$;

-- Forget the caller's link (disconnect). Idempotent.
create or replace function public.clear_newshacker_link()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  delete from public.newshacker_link where user_id = auth.uid();
end;
$$;

-- Whether the caller has a link — the one bit the client is allowed to know.
-- Never exposes the token itself.
create or replace function public.newshacker_link_status()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.newshacker_link where user_id = auth.uid()
  );
$$;

revoke execute on function public.set_newshacker_token(text) from public;
revoke execute on function public.clear_newshacker_link()    from public;
revoke execute on function public.newshacker_link_status()   from public;
grant  execute on function public.set_newshacker_token(text) to authenticated;
grant  execute on function public.clear_newshacker_link()    to authenticated;
grant  execute on function public.newshacker_link_status()   to authenticated;
