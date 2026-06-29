import { useEffect, useState } from 'react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../hooks/useAuth';
import { buildInfo, buildInfoRows, summarizeBuild } from '../lib/buildInfo';
import { isSupabaseConfigured, supabaseHealthUrl } from '../lib/supabase/client';
import {
  formatSupabaseStatus,
  probeSupabaseHealth,
  type SupabaseProbeState,
} from '../lib/supabaseHealth';
import './DebugPage.css';
import './PageHeader.css';

type Row = { label: string; value: string };

function runtimeRows(online: boolean): Row[] {
  const rows: Row[] = [{ label: 'Network', value: online ? 'online' : 'offline' }];
  if (typeof navigator !== 'undefined') {
    const sw =
      'serviceWorker' in navigator
        ? navigator.serviceWorker.controller
          ? 'active'
          : 'registered/none'
        : 'unsupported';
    rows.push({ label: 'Service worker', value: sw });
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
  const env = import.meta.env;
  // Presence only — never render the actual key, and the URL is public but we
  // still only confirm it's wired so the page is safe to leave open.
  const supabaseConfigured = Boolean(
    (env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL) &&
      (env.VITE_SUPABASE_ANON_KEY ||
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  );
  return [
    { label: 'Mode', value: env.MODE },
    { label: 'Supabase', value: supabaseConfigured ? 'configured' : 'not configured (mock data)' },
  ];
}

function DebugSection({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="debug__section">
      <h2 className="debug__heading">{title}</h2>
      <dl className="debug__rows">
        {rows.map((row) => (
          <div key={row.label} style={{ display: 'contents' }}>
            <dt className="debug__label">{row.label}</dt>
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
  // line. Only meaningful when there's a real backend to reach — in mock mode the
  // Configuration section already reports "mock data", so we skip the probe and
  // the row entirely rather than show a misleading "unreachable".
  const [supabaseState, setSupabaseState] = useState<SupabaseProbeState | null>(
    isSupabaseConfigured() ? { status: 'checking' } : null,
  );
  useEffect(() => {
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

  const runtime = runtimeRows(online);
  if (supabaseState) {
    runtime.push({
      label: 'Supabase',
      value: formatSupabaseStatus(supabaseState),
    });
  }

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
