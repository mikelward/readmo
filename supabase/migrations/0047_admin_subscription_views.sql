-- Admin drill-downs between users and feeds for the /admin console:
--   * admin_list_user_feeds(email)      — the feeds a given account subscribes
--     to (powers /admin/users/:email/feeds).
--   * admin_list_feed_subscribers(feed) — the accounts subscribed to a given
--     feed (powers /admin/feeds/:feedId/users).
--
-- `subscriptions` is RLS-gated on auth.uid(), so an operator can't read another
-- user's rows directly. Both reads go through SECURITY DEFINER functions
-- (owned by the migration role, which can see auth.users), admin-gated like the
-- other admin RPCs (0028–0030): they raise 42501 for non-admins. Only
-- display-safe columns leave the boundary — feed title/site_url (never
-- secret_url), the subscriber's email, and subscription metadata (muted,
-- folder, subscribed-at). No writes here; these are read-only views.
--
-- Cost/reliability: two admin-only SQL reads, no external calls — negligible
-- ($0), off every user-facing path.

-- ---------------------------------------------------------------------------
-- Re-create get_capabilities() (last defined in 0030) with a
-- `can_view_subscriptions` flag so a client shipped ahead of this migration
-- keeps the drill-down menu items hidden until the RPCs below actually exist
-- (guardrail #11). An old backend returns the pre-0047 shape (column absent →
-- the client reads it as false).
-- ---------------------------------------------------------------------------
drop function if exists public.get_capabilities();
create or replace function public.get_capabilities()
returns table(
  family                 boolean,
  admin                  boolean,
  allowlist_armed        boolean,
  can_manage_users       boolean,
  can_view_subscriptions boolean
)
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
    true as can_manage_users,
    true as can_view_subscriptions;
$$;

revoke execute on function public.get_capabilities() from public;
grant  execute on function public.get_capabilities() to authenticated;

-- ---------------------------------------------------------------------------
-- The feeds a given account subscribes to. Keyed by email (the client already
-- has it from list_users; the account may exist without ever having signed in).
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_user_feeds(p_email text)
returns table(
  feed_id     uuid,
  title       text,
  site_url    text,
  muted       boolean,
  folder      text,
  created_at  timestamptz
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
      f.id,
      -- The user's own title override wins, matching what they see in-app.
      coalesce(nullif(btrim(s.title_override), ''), f.title) as title,
      f.site_url,
      s.muted,
      s.folder,
      s.created_at
    from public.subscriptions s
    join public.feeds f     on f.id = s.feed_id
    join auth.users  u      on u.id = s.user_id
    where lower(u.email) = lower(btrim(coalesce(p_email, '')))
    order by coalesce(nullif(btrim(s.title_override), ''), f.title);
end;
$$;

-- ---------------------------------------------------------------------------
-- The accounts subscribed to a given feed, annotated with family/blocked so the
-- same status pills as the user list read across.
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_feed_subscribers(p_feed_id uuid)
returns table(
  email       text,
  family      boolean,
  blocked     boolean,
  muted       boolean,
  created_at  timestamptz
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
      lower(u.email)                                                          as email,
      exists (select 1 from public.allowlist a where a.email = lower(u.email)) as family,
      (u.banned_until is not null and u.banned_until > now())                 as blocked,
      s.muted,
      s.created_at
    from public.subscriptions s
    join auth.users u on u.id = s.user_id
    where s.feed_id = p_feed_id
    order by lower(u.email);
end;
$$;

revoke execute on function public.admin_list_user_feeds(text)      from public;
revoke execute on function public.admin_list_feed_subscribers(uuid) from public;
grant  execute on function public.admin_list_user_feeds(text)      to authenticated;
grant  execute on function public.admin_list_feed_subscribers(uuid) to authenticated;
