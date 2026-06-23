import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { buildInfo } from '../lib/buildInfo';
import {
  isSupabaseConfigured,
  supabaseProjectRef,
  supabaseProjectUrl,
  getSupabase,
} from '../lib/supabase/client';
import './DebugPage.css';

type PingState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; count: number | null }
  | { status: 'error'; code: string; message: string };

/** Cheap authenticated read used to surface auth/grant/JWT problems directly —
 * a 42501 (missing grant) or 401 (bad/expired token) shows up here instead of
 * as a silently-empty list. head+count returns no rows, just the count. */
async function ping(table: string): Promise<PingState> {
  try {
    const { error, count } = await getSupabase()
      .from(table)
      .select('*', { count: 'exact', head: true });
    if (error) {
      return {
        status: 'error',
        code: (error as { code?: string }).code ?? '—',
        message: error.message,
      };
    }
    return { status: 'ok', count: count ?? null };
  } catch (err) {
    return {
      status: 'error',
      code: 'throw',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Diagnostics page (`/debug`) — answers "which build is this, what backend is it
 * talking to, and can it actually read the DB?" at a glance. Open to everyone
 * for now. Renders only public info (build metadata, project ref, the signed-in
 * uid) — never the anon key or any secret.
 */
export function DebugPage() {
  useDocumentTitle('Debug · readmo');
  const { user, initializing } = useAuth();
  const configured = isSupabaseConfigured();

  const [itemState, setItemState] = useState<PingState>({ status: 'idle' });
  const [feedsPublic, setFeedsPublic] = useState<PingState>({ status: 'idle' });
  const [sw, setSw] = useState('checking…');
  const [cacheNames, setCacheNames] = useState<string[]>([]);

  useEffect(() => {
    if (!configured) return;
    setItemState({ status: 'checking' });
    setFeedsPublic({ status: 'checking' });
    void ping('item_state').then(setItemState);
    void ping('feeds_public').then(setFeedsPublic);
  }, [configured, user]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      setSw('unsupported');
    } else {
      void navigator.serviceWorker
        .getRegistration()
        .then((r) =>
          setSw(r ? (r.active ? 'active' : 'registered') : 'none'),
        )
        .catch(() => setSw('unknown'));
    }
    if (typeof caches !== 'undefined') {
      void caches.keys().then(setCacheNames).catch(() => setCacheNames([]));
    }
  }, []);

  return (
    <div className="debug">
      <h1>Debug</h1>

      <section>
        <h2>Build</h2>
        <dl>
          <Row label="Version" value={buildInfo.label} />
          <Row label="Environment" value={buildInfo.env} />
          <Row label="Branch" value={buildInfo.ref || '—'} />
          <Row label="Commit" value={buildInfo.shortSha} title={buildInfo.sha} />
          <Row label="Commit count" value={buildInfo.commitCount || '—'} />
          <Row
            label="Committed"
            value={buildInfo.commitTime || '—'}
          />
        </dl>
      </section>

      <section>
        <h2>Backend</h2>
        <dl>
          <Row
            label="Mode"
            value={configured ? 'Supabase (live)' : 'Mock (no env)'}
          />
          {configured && (
            <Row label="Project ref" value={supabaseProjectRef() ?? '—'} />
          )}
          {configured && (
            <Row label="Project URL" value={supabaseProjectUrl() ?? '—'} />
          )}
        </dl>
      </section>

      <section>
        <h2>Auth</h2>
        <dl>
          <Row
            label="Status"
            value={
              initializing ? 'initializing…' : user ? 'signed in' : 'signed out'
            }
          />
          {user && <Row label="uid" value={user.uid} />}
          {user && <Row label="email" value={user.email || '—'} />}
          {user && <Row label="name" value={user.name || '—'} />}
        </dl>
      </section>

      <section>
        <h2>DB connectivity</h2>
        {configured ? (
          <dl>
            <PingRow label="item_state" state={itemState} />
            <PingRow label="feeds_public" state={feedsPublic} />
          </dl>
        ) : (
          <p className="debug__muted">Not configured — running on the mock.</p>
        )}
      </section>

      <section>
        <h2>Service worker &amp; cache</h2>
        <dl>
          <Row label="Service worker" value={sw} />
          <Row
            label="Caches"
            value={cacheNames.length ? cacheNames.join(', ') : 'none'}
          />
        </dl>
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd title={title}>{value}</dd>
    </>
  );
}

function PingRow({ label, state }: { label: string; state: PingState }) {
  let value: string;
  let cls = '';
  if (state.status === 'idle' || state.status === 'checking') {
    value = 'checking…';
  } else if (state.status === 'ok') {
    value = `ok${state.count != null ? ` (${state.count} visible)` : ''}`;
    cls = 'debug__ok';
  } else {
    value = `${state.code}: ${state.message}`;
    cls = 'debug__err';
  }
  return (
    <>
      <dt>{label}</dt>
      <dd className={cls}>{value}</dd>
    </>
  );
}
