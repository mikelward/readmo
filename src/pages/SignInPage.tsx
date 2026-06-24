import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type OAuthProvider } from '../hooks/useAuth';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { isSupabaseConfigured } from '../lib/supabase/client';
import '../components/AppHeader.css';
import '../components/ItemRow.css';
import './SignInPage.css';

interface FromState {
  from?: { pathname?: string; search?: string; hash?: string };
}

const DEMO_ROWS = [
  { source: 'AP News', title: 'FDA Approves New Treatment for Common Form of Heart Disease', age: '1h', domain: 'apnews.com', read: false },
  { source: 'Vox', title: 'Why Your Grocery Bill Keeps Going Up', age: '3h', domain: 'vox.com', read: false },
  { source: 'r/popular', title: 'My Dad Just Retired After 40 Years — Proud of Him', age: '4h', domain: 'reddit.com', read: true },
];

/** Clean sign-in landing (SPEC.md *Auth*). When Supabase is configured the
 * buttons start the real Google/Discord OAuth redirect; otherwise they use the
 * mock sign-in that flips state immediately. Deep links round-trip: RequireAuth
 * stashes the requested location in `state.from`, and we land the user back
 * there after signing in. */
export function SignInPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  useDocumentTitle('Sign in · readmo');

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

  return (
    <div className="signin">
      <div className="signin__hero" aria-hidden="true">
        <div className="app-header signin__mock-header-override">
          <div className="app-header__inner">
            <span className="app-header__brand">readmo</span>
          </div>
        </div>
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
        <p className="signin__tagline">
          A calm, fast reader for your RSS, Atom, and JSON feeds — synced across
          devices and readable offline.
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
        <p className="signin__privacy">
          We use your sign-in only to sync your subscriptions and reading state.
          We never post on your behalf.
          {!isSupabaseConfigured()
            ? ' (Demo mode — no real account is created.)'
            : ''}
        </p>
      </div>
    </div>
  );
}
