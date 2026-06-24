# Scaling guide

Practical steps as user count grows. Each section notes the trigger (when
to act) and the action.

## Already done

- **React Query staleTime (5 min) + refetchOnWindowFocus gated by staleTime.**
  Feed views refetch on focus only when data is stale, not on every tab
  switch. Without this, each open tab per user generates a DB request on
  every window focus event. See PR #68.

---

## Database compute tier

**Trigger:** CPU regularly above ~60%, or p99 query latency climbing.

**Action:** Upgrade the Supabase compute tier (Dashboard → Settings →
Compute). The free/Micro tier has ~1 shared vCPU and 512 MB RAM — it will
saturate quickly under concurrent load. The Small tier (~2 GB RAM, dedicated
vCPU) is the first meaningful step and handles hundreds of concurrent users
comfortably.

---

## Connection pooling (Supavisor)

**Trigger:** Before going to production with real users, or if you see
"remaining connection slots are reserved" errors.

**Action:** Switch to Supabase's Supavisor pooler in **transaction mode**
(port 6543). The default direct connection (port 5432) opens one Postgres
connection per PostgREST worker; Supavisor multiplexes many client
connections over a small pool. The current pool size is 15 — that's fine
for development but a ceiling in production.

The Supabase JS client goes through the REST API (not a direct Postgres
connection), so this matters most for:
- Edge Functions that use a Postgres client directly
- Any future server-side query path (e.g. a background worker)

---

## `feed_items` RPC: `count(*) over()`

**Trigger:** The `feed_items` RPC appears in the slow-query log with high
`mean_time` or `total_time`.

**Action:** The window function `count(*) over()` in `0006_feed_rpcs.sql`
does a full scan of the filtered result set on every call to return the
total item count for pagination UI. With many items/subscriptions this
becomes expensive. Options:

1. **Drop the total count** — most feed readers don't show "X of Y"; remove
   `total_count` from the RPC return and the `total` field from the client.
2. **Estimate** — use `pg_class.reltuples` or a materialized count; good
   enough for "~1,200 items".
3. **Separate cheap count query** — issue a lightweight `count` query only
   when the user explicitly opens a page that shows the total.

---

## Client-side request volume

**Trigger:** `set_config` dominates the query-performance dashboard again
(it is PostgREST's per-request overhead — one row per API call).

**Likely causes and fixes:**

| Cause | Fix |
|---|---|
| staleTime reduced or removed | Restore `staleTime: 5 * 60 * 1000` in `main.tsx` |
| New `useQuery` without staleTime | Ensure all queries inherit or override with a reasonable staleTime |
| Supabase Realtime subscriptions | Each subscription keeps a WebSocket open but also makes REST calls; audit with the dashboard |
| Poller burst on cold start | Stagger `next_fetch_at` across feeds so they don't all come due at once after a restart |

---

## Poller at scale

**Trigger:** Many subscribed feeds; poller cron runs are slow or overlapping.

**Action:** The current poller (`supabase/functions/poll/index.ts`) fetches
all due feeds in a single Edge Function invocation. At scale this will hit
the Edge Function timeout. Split into:

1. A lightweight **scheduler** cron that pages through due feeds and enqueues
   them (e.g. via `pg_net` or a Supabase Queue).
2. A **worker** function invoked per-feed, with its own timeout budget.

This also naturally staggers DB writes instead of bursting them all at once.

---

## Read replicas

**Trigger:** Write latency climbing, or CPU split shows reads dominating.

**Action:** Supabase supports read replicas on Pro and above. The `feed_items`
RPC and all list reads are read-only and safe to route to a replica. The
Supabase JS client doesn't support this natively yet; you'd need to instantiate
a second client pointed at the replica URL for read paths.

---

## Indexes to add as data grows

| Query | Index to add |
|---|---|
| `feed_items` filtering by `user_id` + `sort_at` | Already covered by `items_feed_published_idx` and `item_state_user_item_idx`; revisit if EXPLAIN shows seq scans |
| Library views (pinned/done/hidden per user) | Partial indexes already exist (`item_state_pinned_idx`, etc.) |
| Subscription lookup by `user_id` + `feed_id` | Primary key covers this |

Run `EXPLAIN (ANALYZE, BUFFERS)` on slow queries before adding indexes — the
query planner often surprises you.
