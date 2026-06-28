-- Move the trusted-user allowlist from an Edge Function env var into the DB, and
-- add an admin role so it can be managed at runtime from the /admin UI.
--
-- Until now the allowlist that gates reading-mode full text and Google News
-- feeds lived in the `READMO_ALLOWLIST` Edge Function secret (see
-- supabase/functions/_shared/allowlist.ts), so changing it meant an operator
-- running `supabase secrets set` + redeploy. Two small tables replace it:
--
--   * allowlist(email)   — the trusted-user list, edited via /admin. Keyed by
--     email so family can be pre-authorized before they ever sign up; matched
--     against the caller's verified `auth.jwt() ->> 'email'`.
--   * admin_users(email) — who may reach /admin and edit the allowlist.
--     Bootstrapped once via SQL (there's no admin concept before this), e.g.
--       insert into public.admin_users (email) values ('you@example.com');
--
-- Semantics match the old env var: an EMPTY allowlist is "disarmed" → the gates
-- are open to everyone (and nobody is "family"). A non-empty allowlist arms the
-- gate; only listed emails pass.
--
-- Both tables are touched ONLY by the SECURITY DEFINER RPCs below and by the
-- service role (the gate Edge Functions read `allowlist` to enforce the gate);
-- clients get no direct table grants. Hardening mirrors 0004_access_rpcs.sql:
-- SECURITY DEFINER + `set search_path = ''` + fully-qualified names, and the
-- caller's identity comes from `auth.uid()` / `auth.jwt()`, never a parameter.

-- ---------------------------------------------------------------------------
-- Tables (RLS on, no client policies → only DEFINER RPCs / service role touch
-- them; the service role bypasses RLS but still needs table grants — see 0009).
-- ---------------------------------------------------------------------------
create table if not exists public.admin_users (
  email      text        not null primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.allowlist (
  email      text        not null primary key,
  added_by   text,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
alter table public.allowlist   enable row level security;

-- The gate functions (fulltext / discover) read `allowlist` via the service
-- role; admin_users is only ever read through is_admin() (DEFINER), so it needs
-- no direct grant.
grant select, insert, delete on public.allowlist to service_role;

-- Store emails normalized (lowercased, trimmed) no matter how a row arrives.
-- The RPCs below already lower()/btrim() their inputs, but admin_users and the
-- initial allowlist are *also* seeded by hand via raw SQL (see the bootstrap
-- note above). A mixed-case or space-padded seed row would never match the
-- lowercased `auth.jwt() ->> 'email'` the gates compare against, silently
-- locking the admin out. This trigger makes that impossible at the table level.
create or replace function public.normalize_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

create trigger admin_users_normalize_email
  before insert or update on public.admin_users
  for each row execute function public.normalize_email();

create trigger allowlist_normalize_email
  before insert or update on public.allowlist
  for each row execute function public.normalize_email();

-- ---------------------------------------------------------------------------
-- Internal helpers (DEFINER, NOT client-callable — used only by the RPCs below,
-- which run as the owner and so can execute them regardless of grants). The
-- caller's email is the verified JWT claim, lowercased.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.admin_users
    where email = lower(auth.jwt() ->> 'email')
  );
$$;

-- True when the caller may use the gated features: the allowlist is disarmed
-- (empty) OR the caller's email is on it. So `not email_is_allowlisted()` means
-- exactly "armed AND caller not listed". (Reserved for the deferred direct-RPC
-- Google News gate — see TODO.md; the reading-mode/discovery gates enforce the
-- allowlist in the Edge functions, not here.)
create or replace function public.email_is_allowlisted()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select not exists (select 1 from public.allowlist)
      or exists (
        select 1 from public.allowlist
        where email = lower(auth.jwt() ->> 'email')
      );
$$;

revoke execute on function public.is_admin() from public;
revoke execute on function public.email_is_allowlisted() from public;

-- ---------------------------------------------------------------------------
-- Client-facing RPCs.
-- ---------------------------------------------------------------------------

-- One round-trip that drives the FAMILY chip, the /admin gate, and the client's
-- "should I even call fulltext?" short-circuit. `family` is TRUE only when the
-- allowlist is armed AND the caller is explicitly listed (so a disarmed list
-- shows no chip for anyone); `allowlist_armed` lets the client derive
-- canUseFullText = (not armed) or family.
create or replace function public.get_capabilities()
returns table(family boolean, admin boolean, allowlist_armed boolean)
language sql
security definer
set search_path = ''
stable
as $$
  select
    (
      exists (select 1 from public.allowlist)
      and exists (
        select 1 from public.allowlist
        where email = lower(auth.jwt() ->> 'email')
      )
    ) as family,
    public.is_admin() as admin,
    exists (select 1 from public.allowlist) as allowlist_armed;
$$;

-- Admin-only: list / add / remove allowlist entries. Fail closed with 42501 for
-- non-admins (the client also hides /admin, but the server is the boundary).
create or replace function public.list_allowlist()
returns table(email text, added_by text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  return query
    select a.email, a.added_by, a.created_at
    from public.allowlist a
    order by a.created_at;
end;
$$;

create or replace function public.add_to_allowlist(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'a valid email is required' using errcode = '22023';
  end if;
  insert into public.allowlist (email, added_by)
  values (v_email, lower(auth.jwt() ->> 'email'))
  on conflict (email) do nothing;
end;
$$;

create or replace function public.remove_from_allowlist(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  delete from public.allowlist where email = lower(btrim(coalesce(p_email, '')));
end;
$$;

revoke execute on function public.get_capabilities()        from public;
revoke execute on function public.list_allowlist()          from public;
revoke execute on function public.add_to_allowlist(text)    from public;
revoke execute on function public.remove_from_allowlist(text) from public;
grant  execute on function public.get_capabilities()        to authenticated;
grant  execute on function public.list_allowlist()          to authenticated;
grant  execute on function public.add_to_allowlist(text)    to authenticated;
grant  execute on function public.remove_from_allowlist(text) to authenticated;
