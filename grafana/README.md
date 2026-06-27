# Readmo DB-performance alerting (Grafana Cloud + email)

Alerting-as-code for **layer 1** of [`../OBSERVABILITY.md`](../OBSERVABILITY.md):
Grafana Cloud scrapes Supabase's Metrics API and **pages you by email** when the
database is starving or unreachable — out-of-band, so it adds no load to the DB
and keeps working during a DB outage. When an alert fires, hit the `db-perf`
endpoint (layer 2) for the offending query.

| File | What it is |
|---|---|
| `alerts.rules.yaml` | The alert rules (PromQL) — CPU/mem/disk saturation, connection-pool starvation, slow queries, DB-unreachable. |
| `alertmanager.yaml` | Routing + the **suppression** config (group into one incident, re-notify only every few hours, send "all clear"). |
| `agent.alloy` | Grafana Alloy scrape config (only if you run your own collector instead of Grafana Cloud's hosted scrape). |

## 0. ⚠️ Verify the metric names first (Metrics API is beta)

Metric names, label values (`service_type`, `mountpoint`), and units can differ
per project and change under beta. Dump your live names and sanity-check the
rules before trusting them — confirm each metric the rules use actually exists:

```sh
curl -s -u "service_role:$SUPABASE_SERVICE_ROLE_KEY" \
  "https://$SUPABASE_PROJECT_REF.supabase.co/customer/v1/privileged/metrics" \
  | grep -E '^(node_cpu_seconds_total|node_memory_MemAvailable_bytes|node_filesystem_avail_bytes|pgrst_db_pool_timeouts_total|pg_stat_statements_total_queries|pg_stat_statements_total_time_seconds|http_status_codes_total)' \
  | sort -u
```

If a metric is **missing entirely** (empty result for a line), the project
doesn't emit that family — find the equivalent in the full catalog
(`… | grep -vE '^#' | sed -E 's/[ {].*//' | sort -u`) and fix the rule, or drop
it. Query rate/time alerts use `pg_stat_statements_*` so they cover **all
backends** (PostgREST keeps its own pool straight to Postgres and bypasses the
pooler — a `pgbouncer_stats_*` signal would miss the main workload); the
connection-pool rule uses **PostgREST** pool metrics (`pgrst_*`). A project
fronted by **Supavisor** names its pooler series `supavisor_*` instead, and
`disk` assumes the data volume is `mountpoint="/data"` — verify both here.

## 1. Scrape the Metrics API

**Easiest — Grafana Cloud hosted scrape:** Grafana Cloud → **Connections → Add
new connection → Metrics endpoint** (hosted Prometheus scrape). Point it at
`https://<project-ref>.supabase.co/customer/v1/privileged/metrics`, scheme HTTPS,
**Basic auth** username `service_role`, password = your service-role JWT, scrape
interval `60s`, and set the **job label to `supabase-metrics`** (the rules match
that). Store the JWT as a secret, not inline.

**Or run your own collector:** `alloy run grafana/agent.alloy` with the env vars
named in that file. (Same job label.)

## 2. Email contact point + suppression

**Grafana-managed alerting (recommended for email — no SMTP to run):**
Grafana Cloud → **Alerts & IRM → Contact points → Add** → type **Email** → your
address (default operator inbox: `mikel@mikelward.com`). Then **Notification
policies** → set the policy that matches `service=readmo-db` to mirror
`alertmanager.yaml`: **group by** `alertname, service`, **group wait** 30s,
**group interval** 5m, **repeat interval** 6h (1h for `severity=critical`).
That grouping + repeat interval is what collapses a continuing problem into one
incident instead of an email a minute.

**Or Mimir Alertmanager:** fill the SMTP fields in `alertmanager.yaml`, then
`mimirtool alertmanager load grafana/alertmanager.yaml …`.

## 3. Load the alert rules

```sh
mimirtool rules load grafana/alerts.rules.yaml \
  --address "$GRAFANA_CLOUD_PROM_URL" --id "$GRAFANA_CLOUD_TENANT" --key "$GRAFANA_CLOUD_TOKEN"
```

(Or recreate the same expressions as Grafana-managed alert rules in the UI.)

> **Two different Grafana URLs — don't conflate them.** `mimirtool --address`
> wants the **Mimir API base URL** (e.g. `https://prometheus-us-central1.grafana.net`),
> exposed here as `GRAFANA_CLOUD_PROM_URL`. The Alloy collector's
> `prometheus.remote_write` (step 1) wants the **push endpoint** (the same host
> with `/api/prom/push`), exposed as `GRAFANA_CLOUD_PROM_PUSH_URL`. Both are on
> your Grafana Cloud Prometheus details page; using one for the other makes
> either rule upload or metric forwarding hit the wrong path.

## 4. Test it

- **DB-unreachable path:** temporarily point the scrape at a bad path → `up`
  goes 0 → `ReadmoDBUnreachable` should fire and email after ~2m. Revert.
- **A real saturation alert:** run a deliberately heavy query (e.g. a big
  `generate_series` cross join) on a non-prod project and confirm the CPU /
  pool-checkout alert fires and the email arrives — then that `db-perf` names
  the query.

## Want the page to name the query itself?

These alerts tell you the DB is starving and link you to `db-perf` for the
culprit. To put the offending `pid`/`queryid` *in the alert*, add an external
HTTP/synthetic check (Grafana Synthetic Monitoring) that GETs the `db-perf`
endpoint and alerts on its `severity` field. Still out-of-band (the caller is
external; the RPC is read-only and 3s-bounded). Off by default to keep v1 a pure
scrape.

## Cost

Metrics API: $0 (included). Grafana Cloud free tier covers a one-operator
project's series + alerting. Email: free. See `../OBSERVABILITY.md` for the full
cost/reliability note.
