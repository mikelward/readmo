-- Readmo schema — core relational tables.
--
-- See SPEC.md "Schema (sketch)". Feeds and items are SHARED across users
-- (polled once per distinct feed regardless of subscriber count); per-user
-- state lives in subscriptions, item_state, and folders. RLS (0002) gates who
-- can read what — "shared storage" is NOT "world-readable".
--
-- `uuid` PKs are used for the shared entities (feeds, items) so item ids are
-- opaque and stable; per-user join tables use composite natural PKs.

-- gen_random_uuid() lives in pgcrypto; Supabase ships it but enable defensively.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- feeds — one row per distinct feed URL, shared across all subscribers.
-- ---------------------------------------------------------------------------
create table if not exists public.feeds (
  id               uuid primary key default gen_random_uuid(),
  -- The de-dup key. Two users pasting the same (possibly tokenized) URL land
  -- on ONE row. UNIQUE so the poller and "add feed" upsert collapse cleanly.
  url              text        not null unique,
  -- The fetchable URL when it embeds an auth token / secret in path or query.
  -- NEVER exposed to clients (see 0002: column privileges + the public view).
  -- NULL when the public `url` is itself fetchable.
  secret_url       text,
  -- Display-safe website for the feed (the publisher's home page).
  site_url         text,
  title            text,
  -- Conditional-GET validators (SPEC.md "Feed fetching & parsing"). A 304
  -- reply is free: bump last_fetched_at and stop.
  etag             text,
  last_modified    text,
  last_fetched_at  timestamptz,
  -- When the poller should next consider this feed. The cron selects rows
  -- with next_fetch_at <= now() AND >= 1 subscriber.
  next_fetch_at    timestamptz not null default now(),
  -- Current adaptive poll interval in seconds (healthy ~15-30 min).
  fetch_interval_s integer     not null default 1800,
  -- Circuit-breaker bookkeeping: consecutive failures + last error text.
  error_count      integer     not null default 0,
  last_error       text,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- items — one row per distinct article within a feed, shared across users.
-- ---------------------------------------------------------------------------
create table if not exists public.items (
  id            uuid        primary key default gen_random_uuid(),
  feed_id       uuid        not null references public.feeds(id) on delete cascade,
  -- Stable per-feed identity (explicit guid → url → content hash). De-dup is
  -- on (feed_id, guid).
  guid          text        not null,
  url           text,
  title         text,
  author        text,
  published_at  timestamptz,
  -- SANITIZED HTML only — the poller runs sanitizeContent() before insert.
  content_html  text,
  summary       text,
  -- Media attachments: [{ url, type, length }]. jsonb for indexability.
  enclosures    jsonb       not null default '[]'::jsonb,
  -- Detects in-place edits so the poller can update an existing item rather
  -- than create a duplicate.
  content_hash  text,
  created_at    timestamptz not null default now(),
  -- Effective sort key: feeds that omit/garble dates leave published_at null, so
  -- we fall back to created_at (fetch time) to keep newly-fetched undated items
  -- at the top instead of buried. Matches the client's `published_at ?? created_at`.
  sort_at       timestamptz not null generated always as (coalesce(published_at, created_at)) stored,
  -- De-dup key per SPEC.md "De-dup on (feed_id, guid)".
  unique (feed_id, guid)
);

-- The hot feed query drives from items by (feed_id, sort_at desc).
create index if not exists items_feed_sort_idx
  on public.items (feed_id, sort_at desc);

-- ---------------------------------------------------------------------------
-- subscriptions — user ↔ feed. PK(user_id, feed_id) is the natural key.
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  user_id        uuid        not null references auth.users(id) on delete cascade,
  feed_id        uuid        not null references public.feeds(id) on delete cascade,
  -- Optional folder name (FK-by-value into folders; enforced loosely so a
  -- subscription can sit at the root with folder = NULL).
  folder         text,
  -- Per-user display override for the feed title.
  title_override text,
  -- Muted feeds stay subscribed but drop out of the aggregate (still reachable
  -- on /feed/:id). SPEC.md "Mute feed".
  muted          boolean     not null default false,
  -- Manual drag-to-sort ordering within the list / folder.
  sort           integer     not null default 0,
  created_at     timestamptz not null default now(),
  primary key (user_id, feed_id)
);

-- The feed query joins subscriptions by user_id first.
create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- item_state — SPARSE per-(user,item) triage state. One row only once a user
-- acts on an item (pin/favorite/done/hide/open); absence == default/unread.
-- SPEC.md "item_state is sparse".
-- ---------------------------------------------------------------------------
create table if not exists public.item_state (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  item_id     uuid        not null references public.items(id) on delete cascade,
  -- Five independent states; each boolean carries its own timestamp so the
  -- library views can sort and the 7-day TTLs (hidden/opened) can prune.
  pinned      boolean     not null default false,
  pinned_at   timestamptz,
  favorite    boolean     not null default false,
  favorite_at timestamptz,
  done        boolean     not null default false,
  done_at     timestamptz,
  hidden      boolean     not null default false,
  hidden_at   timestamptz,
  opened      boolean     not null default false,
  opened_at   timestamptz,
  -- Server-assigned monotonic version for conflict resolution (SPEC.md
  -- "Sync"). Bumped by a trigger on every write (0003); clients NEVER set it.
  version     bigint      not null default 0,
  primary key (user_id, item_id)
);

-- Point lookups during the LEFT JOIN in the feed query.
create index if not exists item_state_user_item_idx
  on public.item_state (user_id, item_id);

-- Partial indexes keep the library-view queries (pinned / done / hidden lists
-- for a user) cheap by indexing only the sparse "true" rows. SPEC.md names
-- these exactly.
create index if not exists item_state_pinned_idx
  on public.item_state (user_id) where pinned;
create index if not exists item_state_done_idx
  on public.item_state (user_id) where done;
create index if not exists item_state_hidden_idx
  on public.item_state (user_id) where hidden;

-- ---------------------------------------------------------------------------
-- folders — per-user categories. PK(user_id, name).
-- ---------------------------------------------------------------------------
create table if not exists public.folders (
  user_id uuid    not null references auth.users(id) on delete cascade,
  name    text    not null,
  sort    integer not null default 0,
  primary key (user_id, name)
);
