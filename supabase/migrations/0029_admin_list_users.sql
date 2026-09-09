-- Admin-only view of registered accounts for the /admin user-management list.
--
-- `auth.users` is not client-readable, so list_users() reads it through a
-- SECURITY DEFINER function (owned by the migration role, which can see the auth
-- schema) and annotates each account with:
--   * family — on the trusted-user `allowlist` (reading mode + Google News);
--   * admin  — in `admin_users` (may reach /admin).
-- Admin-gated like the other allowlist RPCs (0028): raises 42501 for non-admins.
-- Promote/demote-to-family on the client reuse add_to_allowlist /
-- remove_from_allowlist (0028) — no new write RPC here.

create or replace function public.list_users()
returns table(
  email           text,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  family          boolean,
  admin           boolean
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
      exists (select 1 from public.admin_users ad where ad.email = lower(u.email)) as admin
    from auth.users u
    where u.email is not null
    order by u.created_at;
end;
$$;

revoke execute on function public.list_users() from public;
grant  execute on function public.list_users() to authenticated;
