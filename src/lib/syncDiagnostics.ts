import { formatTimeAgoLong } from './format';

// Per-channel outcomes of the sync traffic, for `/debug`'s "Sync" section.
// Sync is best-effort by design — every failure is swallowed so the reader is
// never blocked — which also makes it invisible: on a phone with no console, a
// write that never reaches the server or a reverse pull that keeps failing
// looks exactly like "nothing changed". This records, per channel, when it last
// worked and the last failure with its error code, so the evidence is on the
// device the problem happened on.
//
// Session-local and in-memory, like lib/lastFetch.ts: it describes THIS
// session's behavior, holds no item or account data (codes and short server
// messages only), and so needs no per-user scoping or purge.

export type SyncChannel = 'write' | 'refresh' | 'newshackerPush' | 'newshackerPull';

export interface SyncFailure {
  /** Epoch ms the failure was recorded. */
  at: number;
  /** Sanitized description: an error code / status and a short message. */
  detail: string;
}

export interface SyncChannelStats {
  lastOkAt: number | null;
  lastFailure: SyncFailure | null;
  /** Failures this session. */
  failures: number;
}

const CHANNELS: readonly SyncChannel[] = [
  'write',
  'refresh',
  'newshackerPush',
  'newshackerPull',
];

function emptyStats(): SyncChannelStats {
  return { lastOkAt: null, lastFailure: null, failures: 0 };
}

let stats: Record<SyncChannel, SyncChannelStats> = freshStats();

function freshStats(): Record<SyncChannel, SyncChannelStats> {
  const out = {} as Record<SyncChannel, SyncChannelStats>;
  for (const c of CHANNELS) out[c] = emptyStats();
  return out;
}

const MAX_DETAIL = 160;

// Server messages can name an item by uuid (`set_item_state`'s lost-visibility
// error reads "item <uuid> not visible to caller"), and an item uuid is the
// capability `get_shared_item` opens a shared article with — so it must not end
// up on a page people screenshot into bug reports.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function redact(text: string): string {
  return text.replace(UUID_RE, '<id>');
}

/** A short, log-safe description of a sync error. Keeps only the error's code,
 * HTTP status, name and message — never PostgREST's `details`/`hint`, which can
 * echo row values — with any uuid redacted, truncated. */
export function describeSyncError(err: unknown): string {
  if (typeof err === 'string') return redact(err).slice(0, MAX_DETAIL);
  if (typeof err !== 'object' || err === null) return 'unknown error';
  const e = err as {
    code?: unknown;
    status?: unknown;
    name?: unknown;
    message?: unknown;
    context?: { status?: unknown };
  };
  const parts: string[] = [];
  if (typeof e.code === 'string' && e.code) parts.push(e.code);
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.context?.status === 'number'
        ? e.context.status
        : null;
  if (status !== null) parts.push(`HTTP ${status}`);
  if (parts.length === 0 && typeof e.name === 'string' && e.name && e.name !== 'Error') {
    parts.push(e.name);
  }
  const message = typeof e.message === 'string' ? redact(e.message.trim()) : '';
  const head = parts.join(' ');
  const text = head && message ? `${head}: ${message}` : head || message || 'unknown error';
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

/** Record one settled sync attempt on a channel. A failure's `detail` is
 * whatever {@link describeSyncError} makes of the error. */
export function recordSync(channel: SyncChannel, ok: boolean, error?: unknown): void {
  const s = stats[channel];
  const now = Date.now();
  if (ok) {
    s.lastOkAt = now;
    return;
  }
  s.failures += 1;
  s.lastFailure = { at: now, detail: describeSyncError(error) };
}

export function getSyncStats(channel: SyncChannel): SyncChannelStats {
  return stats[channel];
}

/** The `/debug` row value for one channel: when it last worked, and the last
 * failure (with its detail) when there's been one this session. */
export function formatSyncChannel(
  s: SyncChannelStats,
  now: number = Date.now(),
): string {
  const ago = (at: number) => formatTimeAgoLong(Math.floor(at / 1000), new Date(now));
  const okPart = s.lastOkAt === null ? 'no success yet' : `ok ${ago(s.lastOkAt)}`;
  if (!s.lastFailure) return s.lastOkAt === null ? 'not yet' : okPart;
  const failed = `${s.failures} failed, last ${ago(s.lastFailure.at)}: ${s.lastFailure.detail}`;
  return `${okPart} · ${failed}`;
}

/** Whether the channel is currently failing: its most recent outcome was a
 * failure. Drives the row's badge. */
export function isSyncChannelFailing(s: SyncChannelStats): boolean {
  if (!s.lastFailure) return false;
  return s.lastOkAt === null || s.lastFailure.at >= s.lastOkAt;
}

export function _resetSyncDiagnosticsForTests(): void {
  stats = freshStats();
}
