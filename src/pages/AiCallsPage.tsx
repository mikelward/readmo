import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useCapabilities } from '../hooks/useCapabilities';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { AdminDenied } from './AdminDenied';
import type { AiCall, AiCallKind } from '../lib/data/DataSource';
import './AdminPage.css';
import './AiCallsPage.css';

const COUNTS_KEY = ['admin-ai-calls', 'counts'] as const;
const RECENT_KEY = ['admin-ai-calls', 'recent'] as const;

/** How the window's tally is fetched, and how far back the recent list reaches. */
const COUNTS_WINDOW_HOURS = 24;
const RECENT_LIMIT = 200;

const KIND_LABEL: Record<AiCallKind, string> = {
  summary: 'Article summaries',
  spoiler: 'Spoiler-free headlines',
};

/** Coarse severity for the status badge tint. A status the client doesn't know
 * is treated as neutral rather than dropped, so a newer-server value still
 * renders. `ok`/`rewrite`/`none`/`accepted` are healthy outcomes; `failed`/
 * `unreachable` are errors; `unavailable`/`empty`/`blocked` are "declined /
 * nothing to do". See the AiCall.status doc for the full set. */
function severityOf(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  switch (status) {
    case 'ok':
    case 'rewrite':
    case 'none':
    case 'accepted':
      return 'ok';
    case 'failed':
    case 'unreachable':
      return 'bad';
    case 'unavailable':
    case 'empty':
    case 'blocked':
      return 'warn';
    default:
      return 'neutral';
  }
}

function formatWhen(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Operator-only AI-call observability console (`/admin/ai`): recent Gemini
 * generation calls — the reader's article summaries and the poll-time
 * spoiler-free-headline classifier — with their outcomes, so the operator can
 * see whether the AI features are producing results (and why not). Gated on the
 * `admin` capability; the backing `admin_ai_call_log` / `admin_ai_call_counts`
 * RPCs re-check `is_admin()` server-side. */
export function AiCallsPage() {
  usePageTitle('AI calls');
  const ds = useDataSource();
  const { admin } = useCapabilities();

  const counts = useQuery({
    queryKey: COUNTS_KEY,
    queryFn: () => ds.getAiCallCounts(COUNTS_WINDOW_HOURS),
    enabled: admin,
  });
  const recent = useQuery({
    queryKey: RECENT_KEY,
    queryFn: () => ds.listAiCalls(RECENT_LIMIT),
    enabled: admin,
  });

  // Group the window tally by kind for the summary cards (each kind lists its
  // statuses, healthy-first via severity then count).
  const countsByKind = useMemo(() => {
    const out: Record<AiCallKind, { status: string; count: number }[]> = {
      summary: [],
      spoiler: [],
    };
    for (const c of counts.data ?? []) out[c.kind]?.push(c);
    return out;
  }, [counts.data]);

  if (!admin) return <AdminDenied title="AI calls" />;

  const loading = recent.isLoading || counts.isLoading;
  const isError = recent.isError || counts.isError;
  const calls = recent.data ?? [];

  return (
    <div className="admin">
      <div className="page-header">
        <h1 className="page-header__title">AI calls</h1>
      </div>

      <p className="ai-calls__intro">
        Recent Gemini generation calls — article summaries and spoiler-free
        headlines. Both need the <code>GOOGLE_API_KEY</code> secret; a run of{' '}
        <strong>unavailable</strong> means it isn’t set.
      </p>

      <section className="settings__section">
        <div className="ai-calls__summary-head">
          <h2 className="settings__heading">Last 24 hours</h2>
          <button
            type="button"
            className="admin__retry"
            onClick={() => {
              void counts.refetch();
              void recent.refetch();
            }}
            disabled={counts.isFetching || recent.isFetching}
          >
            {counts.isFetching || recent.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className="ai-calls__cards">
          {(['summary', 'spoiler'] as AiCallKind[]).map((kind) => {
            const rows = countsByKind[kind];
            const total = rows.reduce((n, r) => n + r.count, 0);
            return (
              <div key={kind} className="ai-calls__card">
                <div className="ai-calls__card-title">{KIND_LABEL[kind]}</div>
                <div className="ai-calls__card-total">{total}</div>
                <div className="ai-calls__chips">
                  {rows.length === 0 ? (
                    <span className="ai-calls__chip ai-calls__chip--neutral">
                      no calls
                    </span>
                  ) : (
                    rows.map((r) => (
                      <span
                        key={r.status}
                        className={`ai-calls__chip ai-calls__chip--${severityOf(r.status)}`}
                      >
                        {r.status} {r.count}
                      </span>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Recent calls</h2>
        {loading ? (
          <p className="admin__empty">Loading…</p>
        ) : isError ? (
          <p className="admin__empty">
            Couldn’t load AI calls.{' '}
            <button
              type="button"
              className="admin__retry"
              onClick={() => {
                void counts.refetch();
                void recent.refetch();
              }}
            >
              Retry
            </button>
          </p>
        ) : calls.length === 0 ? (
          <p className="admin__empty" data-testid="ai-calls-empty">
            No AI calls recorded yet.
          </p>
        ) : (
          <ul className="admin__list ai-calls__list" data-testid="ai-calls-list">
            {calls.map((c, i) => (
              <AiCallRow key={`${c.createdAt}-${i}`} call={c} />
            ))}
          </ul>
        )}
      </section>

      <p className="admin__back">
        <Link to="/admin">&larr; Back to Admin</Link>
      </p>
    </div>
  );
}

function AiCallRow({ call }: { call: AiCall }) {
  return (
    <li className="admin__row ai-calls__row" data-testid="ai-call-row">
      <div className="ai-calls__row-main">
        <span className="ai-calls__kind">{KIND_LABEL[call.kind]}</span>
        <span
          className={`ai-calls__chip ai-calls__chip--${severityOf(call.status)}`}
        >
          {call.status}
          {call.httpStatus != null ? ` · ${call.httpStatus}` : ''}
        </span>
      </div>
      <div className="ai-calls__row-item">
        {call.itemTitle ?? (call.itemId ? '(untitled item)' : '(item removed)')}
      </div>
      {call.error ? <div className="ai-calls__row-error">{call.error}</div> : null}
      <div className="ai-calls__row-when">{formatWhen(call.createdAt)}</div>
    </li>
  );
}
