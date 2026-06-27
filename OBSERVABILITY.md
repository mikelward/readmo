# Readmo — Observability & database performance alerting

How we get told **as soon as a query (or group of queries) is starving the
database or running longer than it should** — and how we keep that from turning
into a pager that cries wolf every minute.

The design splits into two layers on purpose. Read the *why* before changing it.

## The two layers (and why they're separate)

| Layer | Question it answers | Where it runs | Touches the DB? |
|---|---|---|---|
| **1. Detection + paging** | "Is the database starving / down *right now*?" | **Outside** the DB — Grafana Cloud scrapes Supabase's Metrics API | Read-only scrape, **no in-DB job, no writes** |
| **2. Attribution** | "*Which* query or query group is doing it?" | The `db-perf` Edge Function → read-only `db_perf_diagnostics` RPC | Read-only, **on demand only** |

### Why detection lives outside the database

The instinct that "monitoring a struggling DB by writing to / polling that same
DB makes it worse" is correct, and it drives the whole design:

- **No shared fate.** A monitor that runs *inside* Postgres can't tell you the
  one thing you most need to hear — that the database is **down/unreachable** —
  because it's down too. Grafana scraping the Metrics API over HTTPS treats a
  failed scrape *as* the "DB is down" signal.
- **No added load.** Detection is an external scrape of an endpoint Supabase
  already computes; it puts **zero** query load on the database and writes
  nothing to it. We never make a thrashing DB carry its own alarm.
- **Suppression comes for free.** Grafana's alert engine already does
  deduplication, grouping, `for:` hysteresis (don't fire on a one-tick blip),
  re-notify intervals, and silences. That's exactly the "turn it into one
  incident and stop emailing me every minute" behavior — handled by a tool
  built for it, not a hand-rolled state table in the database we're worried
  about.

Attribution (layer 2) *does* read from the DB, because per-query data only
exists there — but it's **read-only and on-demand**: you (or the Grafana alert's
runbook link) call it *after* you already know there's a problem, so it never
runs on a healthy or an overwhelmed DB unprompted.

## Layer 1 — detection & paging (Supabase Metrics API → Grafana Cloud)

Supabase exposes a Prometheus endpoint with ~200 Postgres/host health series.

- **Endpoint:** `https://<project-ref>.supabase.co/customer/v1/privileged/metrics`
- **Auth:** HTTP Basic — username `service_role`, password = the **service-role
  JWT**. Treat the scrape credential as the secret it is.
- **Format / cadence:** Prometheus text; the set refreshes ~once a minute, so
  scrape once a minute.
- **Availability:** all hosted Supabase projects (incl. free tier). It is
  **beta** (metric names/labels may shift) and **not available on self-hosted**
  Supabase — see *Self-hosted fallback* below.

Point any Prometheus-compatible collector at it. The cheapest managed path is
**Grafana Cloud** (free tier is enough for a one-operator project); a
self-hosted Prometheus + Grafana (`supabase/supabase-grafana`) also works. Setup
steps live in [`SETUP.md` §12](./SETUP.md).

### Alert rules to start with

Tune the numbers to the compute tier (see [`SCALING.md`](./SCALING.md)); these
are sane defaults. Set a **`for:` duration** on each so a single bad minute
doesn't page.

| Alert | Condition (rule of thumb) | `for:` | Severity |
|---|---|---|---|
| **DB unreachable** | scrape of the Metrics API fails / `up == 0` | 2m | critical (page) |
| **Connection saturation** | active+idle connections ≥ ~80% of the pool/tier limit | 5m | critical |
| **CPU pinned** | DB CPU ≥ ~85% | 10m | warning → critical |
| **Long-running queries** | max in-flight query age climbing past the user statement cap (5s authenticated; see migration 0015) | 5m | warning |
| **Disk / WAL pressure** | disk usage trend or replication/WAL backlog rising | 15m | warning |

Route critical alerts to a channel that actually buzzes (Grafana OnCall,
PagerDuty, Opsgenie — all free-tier-friendly). The dedup/grouping/silence
behavior that stops the every-minute spam is configured **here**, in the alert
manager — not in our code.

> **Why these and not "alert on a slow query"?** The Metrics API is
> **aggregate** — it tells you the DB is starving, not which query is to blame.
> That's deliberate (it's also why it's cheap and out-of-band). The "which
> query" answer is layer 2.

## Layer 2 — attribution (`db-perf` Edge Function)

When a layer-1 alert fires, find the culprit:

```sh
curl -s -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  https://<project-ref>.functions.supabase.co/db-perf | jq
```

Returns:

```jsonc
{
  "severity": "warn",            // ok | warn | critical
  "summary": "db-perf warn: 1 long-running query (worst 18s, pid 4711: select * from items …); 2 slow query groups (worst mean 1400ms, queryid 6210…: …)",
  "captured_at": "2026-06-27T…Z",
  "active": [ /* in-flight queries past the long-running threshold, worst first */ ],
  "top":    [ /* worst query groups by total exec time, from pg_stat_statements */ ]
}
```

The `summary` names each offender (active → `pid`; group → `queryid`) **and**
shows its query head, so the alert tells you *which* query is problematic.

- `active` comes from `pg_stat_activity` — the queries running **right now**
  (pid, duration, wait event, query text). This is your "starving the DB *now*"
  view. Active query text can carry literals (e.g. a tokenized feed `secret_url`),
  so in the **logged `summary`** any embedded URL is collapsed to `scheme://host`
  (the rest of the query is kept — the table/columns/WHERE shape is what makes it
  recognizable); the full text is still returned in the service-role-gated
  `active` array for live debugging.
- `top` comes from `pg_stat_statements` — **normalized** query groups (literals
  collapsed to `$1`, so no user data leaks) ranked by accumulated time. This is
  your "death by a thousand cuts" view.

Severity is computed from env-tunable thresholds (`classifyDiagnostics` in
`supabase/functions/_shared/dbPerf.ts`):

| Env var | Default | Meaning |
|---|---|---|
| `DB_PERF_ACTIVE_MS` | `10000` | in-flight query age that counts as long-running |
| `DB_PERF_CRITICAL_MS` | `30000` | in-flight age that's critical (something's stuck) |
| `DB_PERF_SLOW_MEAN_MS` | `1000` | query-group mean exec time that's a chronic offender |
| `DB_PERF_LIMIT` | `10` | how many active queries / groups to return |

The endpoint is **read-only** and **service-role only** (the RPC is RLS-exempt
and surfaces all sessions' activity; it's revoked from `anon`/`authenticated`).
Deploy with `--no-verify-jwt` — it verifies the service-role bearer itself, like
`poll`.

### Runbook stub: a layer-1 alert fired

1. Hit `db-perf` (above). Read `summary`.
2. **A single `active` query is huge** → that pid is starving everyone. Decide
   whether to let the statement timeout kill it (5s authenticated / 3s anon,
   migration 0015) or, if it's a `service_role` batch, `pg_cancel_backend(pid)`.
   File the query shape for an index/rewrite.
3. **No big `active` but `top` shows a high-`total_exec_ms` group** → chronic
   load, not an incident. Add an index or cap call volume; see
   [`SCALING.md` → Indexes / runaway client](./SCALING.md).
4. **`db-perf` itself errors or times out** → the DB is too far gone for even a
   read; treat as the "DB unreachable" path and escalate to the Supabase
   dashboard.

## Self-hosted fallback

The Metrics API is hosted-Supabase only. If readmo's backend is ever
self-hosted, layer 1 must be replaced with the standard
`postgres_exporter` + `node_exporter` → Prometheus stack (same alert rules).
Layer 2 (`db_perf_diagnostics` + `db-perf`) is portable as-is — it's plain SQL +
an Edge Function.

## Cost & reliability (guardrail #5)

- **Supabase Metrics API:** included on all hosted projects — **$0**. One extra
  HTTPS scrape/min, computed by Supabase, **no load on our Postgres**. Beta, so
  metric names may change under us.
- **Grafana Cloud:** free tier covers a one-operator project's metric volume and
  alerting. Paid only if retention/series outgrow the free limits. It is a
  **separate** system from our DB, so it keeps working (and keeps paging) during
  a Supabase incident — that's the entire point.
- **`db-perf` Edge Function + RPC:** **negligible** — invoked only on demand
  (an alert or a human), read-only, self-bounded by a 3s `statement_timeout`. It
  is **off every critical path**: no user request, no signup, and no other
  function depends on it. If it's down or unconfigured, you lose the
  *attribution convenience*, not detection or any user-facing behavior.
- **Paging tool (Grafana OnCall / PagerDuty / Opsgenie):** all have free tiers
  generous enough for one operator. Optional — email-only works for v1.
