import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { buildInfo, buildInfoRows, summarizeBuild } from '../lib/buildInfo';
import './DebugPage.css';
import './PageHeader.css';

type Row = { label: string; value: string };

/** Whether the app is running as an installed PWA (standalone display mode).
 * `navigator.standalone` covers iOS Safari, which doesn't report the media
 * query. Guarded so it's safe under jsdom, where matchMedia may be absent. */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mql = window.matchMedia?.('(display-mode: standalone)');
  const iosStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return Boolean(mql?.matches) || iosStandalone;
}

function runtimeRows(online: boolean): Row[] {
  const rows: Row[] = [{ label: 'Network', value: online ? 'online' : 'offline' }];
  if (typeof navigator !== 'undefined') {
    rows.push({ label: 'Display mode', value: isStandalone() ? 'standalone (installed)' : 'browser' });
    const sw =
      'serviceWorker' in navigator
        ? navigator.serviceWorker.controller
          ? 'active'
          : 'registered/none'
        : 'unsupported';
    rows.push({ label: 'Service worker', value: sw });
    rows.push({ label: 'Language', value: navigator.language || 'unknown' });
    rows.push({ label: 'User agent', value: navigator.userAgent });
  }
  if (typeof window !== 'undefined') {
    rows.push({
      label: 'Viewport',
      value: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio || 1}x`,
    });
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
  const { theme, palette } = useTheme();
  useDocumentTitle('Debug · readmo');

  const accountRows: Row[] = [
    { label: 'Status', value: user ? 'signed in' : 'signed out' },
    ...(user ? [{ label: 'Email', value: user.email }] : []),
    { label: 'Theme', value: theme },
    { label: 'Palette', value: palette },
  ];

  return (
    <div className="debug">
      <div className="page-header">
        <h1 className="page-header__title">Debug</h1>
      </div>
      <p className="debug__summary">{summarizeBuild(buildInfo)}</p>

      <DebugSection title="Build" rows={buildInfoRows(buildInfo)} />
      <DebugSection title="Runtime" rows={runtimeRows(online)} />
      <DebugSection title="Configuration" rows={configRows()} />
      <DebugSection title="Account" rows={accountRows} />
    </div>
  );
}
