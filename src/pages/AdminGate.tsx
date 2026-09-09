import type { ReactNode } from 'react';
import { useCapabilitiesPhase, useCapabilitiesQuery } from '../hooks/useCapabilities';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
import { loadFailureCopy } from '../lib/loadErrorCopy';
import { LoadError } from '../components/LoadError';
import './AdminPage.css';

/** The panel an admin page shows *instead of itself* while it can't yet say
 * whether the caller has access, or null once it can. Every admin page calls
 * this and returns the result when it isn't null, so the three pre-page states
 * read the same everywhere:
 *
 *   - **checking** — the capability flags are still coming. `admin` defaults to
 *     false, so rendering the page's own gate here would tell an operator
 *     they'd been locked out and then take it back a moment later.
 *   - **unavailable** — the read failed, so access was never determined. That's
 *     an operational failure with a Retry, not a denial (Codex P2 on #633): a
 *     backend that's down must not read as "you don't have access".
 *   - **known** — null; the page renders and applies its own `admin` check.
 *
 * It doubles as the guard that keeps the *sections* inside these pages honest.
 * Every admin query is `enabled: admin`, and nothing may fetch while the
 * persisted cache is restoring — so a per-section `isLoading` reads false with
 * no data in that window and falls straight through to its empty copy ("No
 * feeds yet.", "No AI calls recorded yet.", or the allowlist's claim that the
 * gates are open to everyone). Because this gate holds the whole page until the
 * flags are known, restoration is necessarily finished by the time any of those
 * branches evaluate. Keep it ahead of the admin check if you touch these pages;
 * moving it below, or dropping it, brings all of that copy back. */
export function useAdminGate(title: string): ReactNode | null {
  const phase = useCapabilitiesPhase();
  const status = useConnectivityStatus();
  const { error, refetch } = useCapabilitiesQuery();

  if (phase === 'known') return null;

  if (phase === 'unavailable') {
    const copy = loadFailureCopy(status, error, {
      action: 'checking your access',
      noun: 'this page',
    });
    return (
      <div className="admin">
        <div className="page-header">
          <h1 className="page-header__title">{title}</h1>
        </div>
        <LoadError
          headline={copy.headline}
          detail={copy.detail}
          offlineLink={copy.offlineLink}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  // Deliberately the same "Loading…" the sections inside these pages use.
  return (
    <div className="admin">
      <div className="page-header">
        <h1 className="page-header__title">{title}</h1>
      </div>
      <p className="admin__empty">Loading…</p>
    </div>
  );
}
