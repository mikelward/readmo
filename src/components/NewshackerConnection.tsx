import { useId, useState } from 'react';
import { useNewshackerLink } from '../hooks/useNewshackerLink';
import './NewshackerConnection.css';

/**
 * Settings *newshacker* section: connect this account to a newshacker app token
 * so dismissing a Hacker News story in Readmo also marks it Done on newshacker
 * (SPEC.md *Mirror dismissals to newshacker*). Hidden when the data source
 * doesn't support the link (an older backend). Connected → a Disconnect button;
 * disconnected → a token field + Connect.
 */
export function NewshackerConnection() {
  const { supported, linked, connect, disconnect } = useNewshackerLink();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  if (!supported) return null;

  const onConnect = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await connect(trimmed);
      setToken('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnect();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings__section">
      <h2 className="settings__heading">newshacker</h2>
      {linked ? (
        <div className="settings__account">
          <div className="settings__sub-title">Connected</div>
          <button
            type="button"
            className="settings__unsub"
            onClick={onDisconnect}
            disabled={busy}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="nh-connect">
          <label className="nh-connect__label" htmlFor={inputId}>
            newshacker token
          </label>
          <div className="nh-connect__row">
            <input
              id={inputId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="nh-connect__input"
              placeholder="nht_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              type="button"
              className="settings__btn"
              onClick={onConnect}
              disabled={busy || token.trim() === ''}
            >
              Connect
            </button>
          </div>
          <p className="nh-connect__hint">
            Paste a token from newshacker → Settings → Connected apps.
          </p>
        </div>
      )}
      {error && (
        <p className="nh-connect__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
