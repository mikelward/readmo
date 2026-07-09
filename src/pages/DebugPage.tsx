import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FeedProbeResult } from '../lib/data/DataSource';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDebugScrollJumps, useItemSort } from '../hooks/useReadingPrefs';
import { useHomeFeed } from '../hooks/useHomeFeed';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../hooks/useAuth';
import { useDataSource } from '../lib/data/context';
import { buildInfo, buildInfoRows, summarizeBuild } from '../lib/buildInfo';
import { formatLastSync } from '../lib/lastSync';
import { formatLastFeedFetch, getLastFeedFetch } from '../lib/lastFetch';
import { isSupabaseConfigured, supabaseHealthUrl } from '../lib/supabase/client';
import {
  describeSupabase,
  probeSupabaseHealth,
  type StatusBadge,
  type SupabaseProbeState,
} from '../lib/supabaseHealth';
import './DebugPage.css';
import './PageHeader.css';

type Row = { label: string; value: string; state?: StatusBadge };

function runtimeRows(
  online: boolean,
  supabase: Row,
  lastSync: Row,
  lastFetch: Row,
): Row[] {
  const hasNavigator = typeof navigator !== 'undefined';
  // Badged status rows first, grouped together — the glanceable health signals
  // (Network, Service worker, Supabase) read as one block of dots.
  const rows: Row[] = [
    { label: 'Network', value: online ? 'online' : 'offline', state: online ? 'ok' : 'down' },
  ];
  if (hasNavigator) {
    const sw =
      'serviceWorker' in navigator
        ? navigator.serviceWorker.controller
          ? 'active'
          : 'registered/none'
        : 'unsupported';
    rows.push({ label: 'Service worker', value: sw, state: sw === 'active' ? 'ok' : 'idle' });
  }
  rows.push(supabase);
  // Last sync and Last fetch sit just under Supabase — both describe traffic
  // against that backend — then the informational rows (no badge) follow.
  rows.push(lastSync);
  rows.push(lastFetch);
  if (hasNavigator) {
    rows.push({ label: 'Language', value: navigator.language || 'unknown' });
  }
  try {
    rows.push({
      label: 'Time zone',
      value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    });
  } catch {
    // Intl unavailable — skip the row rather than crash the debug page.
  }
  return rows;
}

function configRows(): Row[] {
  // Supabase presence now lives in the Runtime section as a live-reachability
  // status row (badge + reachable/unreachable/not-configured), so it isn't
  // duplicated here.
  return [{ label: 'Mode', value: import.meta.env.MODE }];
}

function DebugSection({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="debug__section">
      <h2 className="debug__heading">{title}</h2>
      <dl className="debug__rows">
        {rows.map((row) => (
          <div key={row.label} style={{ display: 'contents' }}>
            <dt className="debug__label">
              {/* Decorative: the row value carries the same status as text, so
                  the badge isn't the only signal (WCAG 1.4.1). */}
              <span className="debug__badge" data-state={row.state} aria-hidden="true" />
              {row.label}
            </dt>
            <dd className="debug__value">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** `/debug` — build, runtime, and config diagnostics. Open to everyone (no
 * auth gate) and shows only public/presence info, no secrets. */
export function DebugPage() {
  const online = useOnlineStatus();
  const { user } = useAuth();
  const dataSource = useDataSource();
  const { debugScrollJumps, setDebugScrollJumps } = useDebugScrollJumps();
  // The probe must exercise the same read as the feed view being diagnosed,
  // so it runs under the reader's active body sort and, when the drawer's Home
  // override scopes `/` to a folder, against that folder.
  const { itemSort } = useItemSort();
  const { homeFeed } = useHomeFeed();
  useDocumentTitle('Debug · readmo');

  // Live backend reachability, the readmo analog of newshacker's /debug Services
  // line. `null` means unconfigured (mock mode) — the row still shows, with a
  // neutral badge, rather than probing a backend that isn't there.
  const [supabaseState, setSupabaseState] = useState<SupabaseProbeState | null>(
    isSupabaseConfigured() ? { status: 'checking' } : null,
  );
  useEffect(() => {
    // Gate on full configuration, not just a URL: with the URL set but the anon
    // key missing the app still runs on mock data (isSupabaseConfigured() is
    // false), yet supabaseHealthUrl() returns a URL. Probing anyway would flip
    // the row to a misleading "reachable" for a backend the app isn't using.
    if (!isSupabaseConfigured()) return;
    const healthUrl = supabaseHealthUrl();
    if (!healthUrl) return;
    let cancelled = false;
    void probeSupabaseHealth(healthUrl).then((health) => {
      if (!cancelled) setSupabaseState({ status: 'done', health });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const accountRows: Row[] = [
    { label: 'Status', value: user ? 'signed in' : 'signed out' },
    ...(user ? [{ label: 'Email', value: user.email }] : []),
  ];

  const supabase = describeSupabase(supabaseState);
  // The most recent feed-list fetch outcome — when it ran and, on failure,
  // what the server said (rate limit, 5xx, network) — since the console isn't
  // reachable on a phone.
  const lastFetch = getLastFeedFetch();
  const runtime = runtimeRows(
    online,
    { label: 'Supabase', value: supabase.value, state: supabase.badge },
    { label: 'Last sync', value: formatLastSync(dataSource.getLastSyncedAt?.()) },
    {
      label: 'Last fetch',
      value: formatLastFeedFetch(lastFetch),
      state: lastFetch ? (lastFetch.ok ? 'ok' : 'down') : undefined,
    },
  );

  return (
    <div className="debug">
      <div className="page-header">
        <h1 className="page-header__title">Debug</h1>
      </div>
      <p className="debug__summary">{summarizeBuild(buildInfo)}</p>

      <DebugSection title="Build" rows={buildInfoRows(buildInfo)} />
      <DebugSection title="Runtime" rows={runtime} />
      <DebugSection title="Configuration" rows={configRows()} />
      <DebugSection title="Account" rows={accountRows} />

      <section className="debug__section">
        <h2 className="debug__heading">Diagnostics</h2>
        <label className="debug__toggle">
          <input
            type="checkbox"
            className="debug__toggle-check"
            checked={debugScrollJumps}
            onChange={(e) => setDebugScrollJumps(e.target.checked)}
          />
          <span className="debug__toggle-title">Scroll-jump diagnostics</span>
        </label>
        <Link to="/debug/scroll" className="debug__link">
          Scroll-jump timeline
        </Link>
        {dataSource.debugFeedProbe ? (
          <FeedProbe
            run={() =>
              dataSource.debugFeedProbe!(
                itemSort,
                homeFeed.kind === 'folder' ? homeFeed.name : null,
              )
            }
          />
        ) : null}
      </section>
    </div>
  );
}

/** On-demand feed-read probe: runs the grouped windowed home read (and a flat
 * page) outside the query cache and lists where rows survive — raw backend
 * rows, resolved rows, and the per-feed split — so an empty grouped view can
 * be diagnosed from a phone with no devtools. */
function FeedProbe({ run }: { run: () => Promise<FeedProbeResult> }) {
  const [state, setState] = useState<
    { phase: 'idle' } | { phase: 'running' } | { phase: 'done'; result: FeedProbeResult }
  >({ phase: 'idle' });
  const rows: Row[] =
    state.phase === 'done'
      ? [
          ...(state.result.error
            ? [{ label: 'Error', value: state.result.error, state: 'down' as StatusBadge }]
            : []),
          {
            label: 'Grouped raw rows',
            value:
              state.result.groupedRawRows === null
                ? 'n/a'
                : String(state.result.groupedRawRows),
          },
          { label: 'Grouped resolved', value: String(state.result.groupedResolvedRows) },
          { label: 'Flat page rows', value: String(state.result.flatResolvedRows) },
          { label: 'Grouped read time', value: `${state.result.groupedMs} ms` },
          ...state.result.perFeed.map((f) => ({
            label: f.title,
            value: String(f.rows),
          })),
        ]
      : [];
  return (
    <div className="debug__probe">
      <button
        type="button"
        className="debug__probe-btn"
        disabled={state.phase === 'running'}
        onClick={() => {
          setState({ phase: 'running' });
          void run().then(
            (result) => setState({ phase: 'done', result }),
            (err: unknown) =>
              setState({
                phase: 'done',
                result: {
                  groupedMs: 0,
                  groupedRawRows: null,
                  groupedResolvedRows: 0,
                  perFeed: [],
                  flatResolvedRows: 0,
                  error: err instanceof Error ? err.message : String(err),
                },
              }),
          );
        }}
      >
        {state.phase === 'running' ? 'Running…' : 'Run feed probe'}
      </button>
      {state.phase === 'done' ? (
        <dl className="debug__rows" data-testid="feed-probe-results">
          {rows.map((row) => (
            <div key={row.label} style={{ display: 'contents' }}>
              <dt className="debug__label">
                <span className="debug__badge" data-state={row.state} aria-hidden="true" />
                {row.label}
              </dt>
              <dd className="debug__value">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
