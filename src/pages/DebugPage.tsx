import { useEffect, useState } from 'react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../hooks/useAuth';
import { buildInfo, buildInfoRows, summarizeBuild } from '../lib/buildInfo';
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

function runtimeRows(online: boolean): Row[] {
  const rows: Row[] = [
    { label: 'Network', value: online ? 'online' : 'offline', state: online ? 'ok' : 'down' },
  ];
  if (typeof navigator !== 'undefined') {
    const sw =
      'serviceWorker' in navigator
        ? navigator.serviceWorker.controller
          ? 'active'
          : 'registered/none'
        : 'unsupported';
    rows.push({ label: 'Service worker', value: sw, state: sw === 'active' ? 'ok' : 'idle' });
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
  const runtime = runtimeRows(online);
  runtime.push({ label: 'Supabase', value: supabase.value, state: supabase.badge });

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
    </div>
  );
}
