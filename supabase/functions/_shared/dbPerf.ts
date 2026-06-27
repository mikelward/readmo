// Database performance diagnostics — pure, testable logic for the `db-perf`
// Edge Function.
//
// The Edge Function calls the `db_perf_diagnostics` RPC (migration 0022), which
// returns the current in-flight long-running queries (`active`) and the worst
// query *groups* by accumulated execution time (`top`, from
// pg_stat_statements). This module turns that raw snapshot into a severity
// verdict + one-line summary that a Grafana alert annotation or a `curl`-ing
// operator can read at a glance.
//
// It deliberately holds NO transport/DB code (that stays in the thin Deno
// entrypoint, which the vitest sandbox can't run) — same split as
// signupNotification.ts / the poller. Everything here is pure and unit-tested.

import { redactUrl } from './urlSafety.ts';

type Env = Record<string, string | undefined>;

/** An in-flight query from pg_stat_activity (shape returned by the RPC). */
export interface ActiveQuery {
  pid?: number | null;
  username?: string | null;
  state?: string | null;
  wait_event_type?: string | null;
  wait_event?: string | null;
  duration_ms?: number | null;
  query?: string | null;
}

/** A query *group* from pg_stat_statements (shape returned by the RPC). */
export interface TopQuery {
  queryid?: string | null;
  calls?: number | null;
  mean_exec_ms?: number | null;
  total_exec_ms?: number | null;
  max_exec_ms?: number | null;
  row_count?: number | null;
  query?: string | null;
}

/** The full snapshot returned by `db_perf_diagnostics`. */
export interface Diagnostics {
  captured_at?: string | null;
  active?: ActiveQuery[] | null;
  top?: TopQuery[] | null;
}

/** Tunable thresholds (resolved from the Functions environment). */
export interface Thresholds {
  /** A live query at/above this age (ms) is a long-runner worth flagging. */
  activeMs: number;
  /** A live query at/above this age (ms) is critical (starving the DB now). */
  criticalMs: number;
  /** A query *group* whose mean execution time is at/above this (ms) is slow. */
  slowMeanMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  activeMs: 10_000, // 10s — well past the 5s authenticated user statement cap
  criticalMs: 30_000, // 30s — something is genuinely stuck/starving
  slowMeanMs: 1_000, // 1s average across calls is a chronic offender
};

/** How many rows the RPC should return (`p_limit`). */
export const DEFAULT_LIMIT = 10;

export type Severity = 'ok' | 'warn' | 'critical';

/** The verdict produced from a snapshot. */
export interface PerfVerdict {
  severity: Severity;
  /** Active queries at/above the long-running threshold (worst first). */
  activeBreaches: ActiveQuery[];
  /** Query groups at/above the slow-mean threshold (worst total first). */
  slowGroups: TopQuery[];
  /** One-line, operator-facing summary safe to drop into a log or alert. */
  summary: string;
}

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  // Ignore garbage / non-positive overrides rather than producing a config that
  // flags everything (0) or nothing (NaN/negative).
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve thresholds from env, falling back to DEFAULT_THRESHOLDS per field. */
export function resolveThresholds(env: Env): Thresholds {
  return {
    activeMs: num(env, 'DB_PERF_ACTIVE_MS', DEFAULT_THRESHOLDS.activeMs),
    criticalMs: num(env, 'DB_PERF_CRITICAL_MS', DEFAULT_THRESHOLDS.criticalMs),
    slowMeanMs: num(env, 'DB_PERF_SLOW_MEAN_MS', DEFAULT_THRESHOLDS.slowMeanMs),
  };
}

/** Resolve the RPC row limit from env (`DB_PERF_LIMIT`). */
export function resolveLimit(env: Env): number {
  return Math.round(num(env, 'DB_PERF_LIMIT', DEFAULT_LIMIT));
}

/** Collapse a query string to a single trimmed line for a summary/log. */
export function redactQuery(query: unknown, max = 120): string {
  if (query == null) return '';
  const oneLine = String(query)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Sanitize a raw query string for logging: collapse any embedded URL to
 * `scheme://host` (the same reduction `poll` uses via redactUrl), then
 * single-line + truncate via redactQuery.
 *
 * This is the deliberate middle ground for `pg_stat_activity.query`, whose text
 * CAN carry literals: a feed `secret_url` token lives in a URL's path/query, so
 * stripping URLs down to scheme://host removes the token while KEEPING the query
 * itself recognizable (table, columns, WHERE shape) — the alert still tells you
 * which query is problematic. Non-URL literals are left intact on purpose: the
 * operator already has DB access, and gutting the text would make the monitor
 * useless. pg_stat_statements text is already normalized, so it skips this.
 */
export function sanitizeQueryText(query: unknown, max = 120): string {
  if (query == null) return '';
  // Match http(s) URLs (optionally single-quoted in SQL) and reduce each to
  // scheme://host. The trailing char class stops at SQL string/paren/space
  // boundaries so we don't swallow the rest of the statement.
  const urlCollapsed = String(query).replace(
    /https?:\/\/[^\s'"`)]+/gi,
    (m) => redactUrl(m),
  );
  return redactQuery(urlCollapsed, max);
}

/**
 * Classify a diagnostics snapshot into a severity verdict.
 *
 *  - critical: any in-flight query has been running >= criticalMs (a single
 *    query holding the DB hostage right now).
 *  - warn: any in-flight query >= activeMs, OR any query group's mean exec time
 *    >= slowMeanMs (a chronic offender draining capacity over many calls).
 *  - ok: neither.
 */
export function classifyDiagnostics(
  diag: Diagnostics,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): PerfVerdict {
  const active = (diag.active ?? []).filter((a) => a != null);
  const top = (diag.top ?? []).filter((t) => t != null);

  const activeBreaches = active
    .filter((a) => (a.duration_ms ?? 0) >= thresholds.activeMs)
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0));

  const slowGroups = top
    .filter((t) => (t.mean_exec_ms ?? 0) >= thresholds.slowMeanMs)
    .sort((a, b) => (b.total_exec_ms ?? 0) - (a.total_exec_ms ?? 0));

  const hasCritical = activeBreaches.some(
    (a) => (a.duration_ms ?? 0) >= thresholds.criticalMs,
  );

  let severity: Severity = 'ok';
  if (hasCritical) severity = 'critical';
  else if (activeBreaches.length > 0 || slowGroups.length > 0) severity = 'warn';

  return {
    severity,
    activeBreaches,
    slowGroups,
    summary: summarize(severity, activeBreaches, slowGroups),
  };
}

function summarize(
  severity: Severity,
  activeBreaches: ActiveQuery[],
  slowGroups: TopQuery[],
): string {
  if (severity === 'ok') {
    return 'db-perf ok: no long-running queries or slow query groups';
  }

  const parts: string[] = [];
  if (activeBreaches.length > 0) {
    const worst = activeBreaches[0];
    const secs = Math.round((worst.duration_ms ?? 0) / 1000);
    // Identify the offender (pid, so the operator can pg_cancel_backend it) AND
    // show the query head so the alert says *which* query — with embedded URLs
    // collapsed to scheme://host so a feed token doesn't land in the logs
    // (sanitizeQueryText; cf. poll's redactUrl).
    const pid = worst.pid != null ? `pid ${worst.pid}` : 'pid unknown';
    parts.push(
      `${activeBreaches.length} long-running quer${activeBreaches.length === 1 ? 'y' : 'ies'} ` +
        `(worst ${secs}s, ${pid}: ${sanitizeQueryText(worst.query) || '(unknown)'})`,
    );
  }
  if (slowGroups.length > 0) {
    const worst = slowGroups[0];
    // pg_stat_statements text is already normalized (literals collapsed to
    // $1/$2…), so the group's shape carries no user data; name it by queryid +
    // its query head so the alert points at the exact group.
    const id = worst.queryid != null ? `queryid ${worst.queryid}` : 'queryid unknown';
    parts.push(
      `${slowGroups.length} slow query group${slowGroups.length === 1 ? '' : 's'} ` +
        `(worst mean ${worst.mean_exec_ms ?? '?'}ms, ${id}: ${redactQuery(worst.query) || '(unknown)'})`,
    );
  }
  return `db-perf ${severity}: ${parts.join('; ')}`;
}
