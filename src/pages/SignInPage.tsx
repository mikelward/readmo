import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type OAuthProvider } from '../hooks/useAuth';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { isSupabaseConfigured } from '../lib/supabase/client';
import '../components/ItemRow.css';
import './SignInPage.css';

interface FromState {
  from?: { pathname?: string; search?: string; hash?: string };
}

// r/popular sits in the middle, not last: the bottom row is partly covered by
// the hero's fade gradient, which would wash out its source/meta line. Keeping a
// crisp row (here the Reddit one) clear of the fade keeps the source legible.
const DEMO_ROWS = [
  { source: 'AP News', title: 'FDA Approves New Treatment for Common Form of Heart Disease', age: '1h', domain: 'apnews.com', read: false },
  { source: 'r/popular', title: 'My Dad Just Retired After 40 Years — Proud of Him', age: '4h', domain: 'reddit.com', read: true },
  { source: 'Vox', title: 'Why Your Grocery Bill Keeps Going Up', age: '3h', domain: 'vox.com', read: false },
];

/** Clean sign-in landing (SPEC.md *Auth*). When Supabase is configured the OAuth
 * buttons start the real Google/Discord redirect and the email form sends a
 * passwordless magic link; otherwise both use the mock sign-in that flips state
 * immediately. Deep links round-trip: RequireAuth stashes the requested location
 * in `state.from`, and we land the user back there after signing in. */
export function SignInPage() {
  const { user, signIn, signInWithEmail } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  usePageTitle('Sign in');

  const [email, setEmail] = useState('');
  // idle → sending → sent (magic link on its way); an error drops back to idle.
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as FromState | null)?.from;
  const target = from?.pathname
    ? `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`
    : '/';

  // Already signed in (e.g. landing here after an OAuth callback + reload): send
  // the user into the app instead of showing the sign-in screen.
  if (user) return <Navigate to={target} replace />;

  const handleSignIn = (provider: OAuthProvider) => {
    signIn(provider, target);
    // The OAuth path navigates via a full-page redirect (preserving `target` as
    // redirectTo); only the mock path needs an in-app navigate.
    if (!isSupabaseConfigured()) navigate(target, { replace: true });
  };

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value || phase === 'sending') return;
    setError(null);
    setPhase('sending');
    const { error: err } = await signInWithEmail(value, target);
    // Mock/demo path signs in immediately with no email sent — go straight in,
    // mirroring the mock OAuth buttons.
    if (!isSupabaseConfigured()) {
      navigate(target, { replace: true });
      return;
    }
    if (err) {
      setError(err);
      setPhase('idle');
    } else {
      setPhase('sent');
    }
  };

  return (
    <div className="signin">
      <div className="signin__hero" aria-hidden="true">
        <ul className="signin__mock-feed">
          {DEMO_ROWS.map((row, i) => (
            <li key={i} className={`item-row${row.read ? ' item-row--opened' : ''}`}>
              <div className="item-row__body">
                <span className="item-row__title-text">{row.title}</span>
                <span className="item-row__meta">{row.source} · {row.age} · {row.domain}</span>
              </div>
              <div className="pin-btn" />
            </li>
          ))}
        </ul>
        <div className="signin__mock-fade" />
      </div>

      <div className="signin__card">
        <div className="signin__brand">readmo</div>

        {phase === 'sent' ? (
          <div className="signin__sent">
            <p className="signin__sent-lead">Check your email</p>
            <p className="signin__sent-detail">
              We sent a sign-in link to <strong>{email}</strong>.
            </p>
            <button
              type="button"
              className="signin__btn"
              onClick={() => {
                setPhase('idle');
                setEmail('');
              }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <p className="signin__tagline">
              A calm, fast reader for your RSS, Atom, and JSON feeds — synced
              across devices and readable offline.
            </p>
            <div className="signin__buttons">
              <button
                type="button"
                className="signin__btn"
                onClick={() => handleSignIn('google')}
              >
                Continue with Google
              </button>
              <button
                type="button"
                className="signin__btn"
                onClick={() => handleSignIn('discord')}
              >
                Continue with Discord
              </button>
            </div>

            <div className="signin__divider">or</div>

            <form className="signin__email-form" onSubmit={handleEmailSubmit}>
              <label className="signin__email-label" htmlFor="signin-email">
                Email
              </label>
              <input
                id="signin-email"
                type="email"
                required
                autoComplete="email"
                className="signin__email-input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                disabled={phase === 'sending'}
              />
              <button
                type="submit"
                className="signin__btn signin__btn--primary"
                disabled={phase === 'sending'}
              >
                {phase === 'sending' ? 'Sending…' : 'Email me a link'}
              </button>
              {error && (
                <p className="signin__error" role="alert">
                  {error}
                </p>
              )}
            </form>

            <p className="signin__privacy">
              We use your sign-in only to sync your subscriptions and reading
              state. We never post on your behalf.
              {!isSupabaseConfigured()
                ? ' (Demo mode — no real account is created.)'
                : ''}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
