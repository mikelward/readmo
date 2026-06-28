-- Admin user management: delete / block / unblock accounts, and a global
-- "allow new sign-ups" switch — all driven from /admin.
--
-- These operate on `auth.users`, which is neither client-readable nor
-- -writable, so they run through SECURITY DEFINER functions owned by the
-- migration role (which can touch the auth schema) — the same shape as the
-- allowlist RPCs in 0028 and list_users() in 0029. Each is admin-gated via
-- is_admin() (0028) and fails closed with 42501 for non-admins. Deleting and
-- blocking refuse to target the calling admin, so an operator can't delete or
-- lock themselves out.
--
-- A direct DELETE on auth.users cascades to the reader's own data through the
-- ON DELETE CASCADE foreign keys on subscriptions / item_state / folders
-- (0001) and to GoTrue's own auth.identities / sessions / refresh_tokens; the
-- email-keyed allowlist / admin_users rows aren't covered by that cascade, so
-- the delete clears them explicitly first.
--
-- Sign-up disabling is a single-row app_settings flag enforced by a BEFORE
-- INSERT trigger on auth.users (it coexists with the AFTER INSERT notify
-- trigger from 0012). The read the trigger uses fails OPEN — a missing or
-- unreadable row leaves sign-ups enabled — so a glitch can never silently wall
-- off registration.

-- ---------------------------------------------------------------------------
-- app_settings: global operator switches (single row).
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  -- Pinned to TRUE by the primary key + check, so there is exactly one row.
  id              boolean     not null primary key default true,
  signups_enabled boolean     not null default true,
  updated_at      timestamptz not null default now(),
  constraint app_settings_singleton check (id)
);

alter table public.app_settings enable row level security;

-- Seed the singleton so every read finds a row (sign-ups enabled by default).
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Sign-up gating.
-- ---------------------------------------------------------------------------
-- Internal: are sign-ups currently allowed? Fails OPEN — a missing row yields
-- TRUE, so registration is never silently broken by a bad/absent setting.
create or replace function public.signups_enabled()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    (select s.signups_enabled from public.app_settings s where s.id),
    true
  );
$$;
revoke execute on function public.signups_enabled() from public;

-- Block new account creation while sign-ups are disabled. BEFORE INSERT on
-- auth.users (coexists with the AFTER INSERT notify trigger from 0012).
create or replace function public.enforce_signups_enabled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.signups_enabled() then
    raise exception 'sign-ups are disabled' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_signups_enabled on auth.users;
create trigger enforce_signups_enabled
  before insert on auth.users
  for each row execute function public.enforce_signups_enabled();

-- Admin-only read / write of the sign-up switch.
create or replace function public.get_signups_enabled()
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  return public.signups_enabled();
end;
$$;

create or replace function public.set_signups_enabled(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  update public.app_settings
    set signups_enabled = coalesce(p_enabled, true), updated_at = now()
    where id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Delete / block / unblock a registered account (admin-only).
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_user(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_caller text := lower(auth.jwt() ->> 'email');
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if v_email = '' then
    raise exception 'an email is required' using errcode = '22023';
  end if;
  if v_email = v_caller then
    raise exception 'you can''t delete your own account' using errcode = '42501';
  end if;
  -- Email-keyed memberships aren't covered by the auth.users FK cascade, so
  -- clear them first; the cascade on subscriptions / item_state / folders
  -- (0001) handles the deleted user's reader data.
  delete from public.allowlist   where email = v_email;
  delete from public.admin_users where email = v_email;
  delete from auth.users where lower(email) = v_email;
end;
$$;

create or replace function public.admin_set_user_blocked(p_email text, p_blocked boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_caller text := lower(auth.jwt() ->> 'email');
begin
  if not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if v_email = '' then
    raise exception 'an email is required' using errcode = '22023';
  end if;
  if v_email = v_caller then
    raise exception 'you can''t block your own account' using errcode = '42501';
  end if;
  -- GoTrue refuses sign-in while banned_until is in the future; a far-future
  -- stamp = blocked, NULL = active. Mirrors auth.admin.updateUserById's
  -- ban_duration without needing the service-role admin API.
  update auth.users
    set banned_until = case when p_blocked then now() + interval '100 years' else null end
    where lower(email) = v_email;
end;
$$;

-- ---------------------------------------------------------------------------
-- Re-create get_capabilities() (0028) with a `can_manage_users` flag so the
-- client can tell whether THIS migration is deployed. The frontend auto-deploys
-- ahead of migrations, so a new client can run against a backend that still has
-- 0028/0029 but not 0030; that old get_capabilities omits the column, the client
-- reads it as false, and hides the Block / Delete / sign-up controls whose RPCs
-- aren't there yet. The flag is a literal TRUE — the function only exists, and
-- so can only return it, once 0030 is live. The OUT columns change, so drop
-- first (create-or-replace can't change the return type).
-- ---------------------------------------------------------------------------
drop function if exists public.get_capabilities();
create or replace function public.get_capabilities()
returns table(family boolean, admin boolean, allowlist_armed boolean, can_manage_users boolean)
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
    exists (select 1 from public.allowlist) as allowlist_armed,
    true as can_manage_users;
$$;
revoke execute on function public.get_capabilities() from public;
grant  execute on function public.get_capabilities() to authenticated;

-- ---------------------------------------------------------------------------
-- Re-create list_users() (0029) with a `blocked` flag. The OUT columns change,
-- so the old function is dropped first (create-or-replace can't change the
-- return type).
-- ---------------------------------------------------------------------------
drop function if exists public.list_users();
create or replace function public.list_users()
returns table(
  email           text,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  family          boolean,
  admin           boolean,
  blocked         boolean
)
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
    select
      lower(u.email)                                                        as email,
      u.created_at,
      u.last_sign_in_at,
      exists (select 1 from public.allowlist a   where a.email  = lower(u.email)) as family,
      exists (select 1 from public.admin_users ad where ad.email = lower(u.email)) as admin,
      (u.banned_until is not null and u.banned_until > now())               as blocked
    from auth.users u
    where u.email is not null
    order by u.created_at;
end;
$$;

revoke execute on function public.get_signups_enabled()                  from public;
revoke execute on function public.set_signups_enabled(boolean)           from public;
revoke execute on function public.admin_delete_user(text)                from public;
revoke execute on function public.admin_set_user_blocked(text, boolean)  from public;
revoke execute on function public.list_users()                           from public;
grant  execute on function public.get_signups_enabled()                  to authenticated;
grant  execute on function public.set_signups_enabled(boolean)           to authenticated;
grant  execute on function public.admin_delete_user(text)                to authenticated;
grant  execute on function public.admin_set_user_blocked(text, boolean)  to authenticated;
grant  execute on function public.list_users()                           to authenticated;
