import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type OAuthProvider } from '../hooks/useAuth';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { isSupabaseConfigured } from '../lib/supabase/client';
import './SignInPage.css';

interface FromState {
  from?: { pathname?: string; search?: string; hash?: string };
}

/** Clean sign-in landing (SPEC.md *Auth*). When Supabase is configured the
 * buttons start the real Google/GitHub OAuth redirect; otherwise they use the
 * mock sign-in that flips state immediately. Deep links round-trip: RequireAuth
 * stashes the requested location in `state.from`, and we land the user back
 * there after signing in. */
export function SignInPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  useDocumentTitle('Sign in · readmo');

  const from = (location.state as FromState | null)?.from;
  const target = from?.pathname
    ? `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`
    : '/';

  const handleSignIn = (provider: OAuthProvider) => {
    signIn(provider, target);
    // The OAuth path navigates via a full-page redirect (preserving `target` as
    // redirectTo); only the mock path needs an in-app navigate.
    if (!isSupabaseConfigured()) navigate(target, { replace: true });
  };

  return (
    <div className="signin">
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
            onClick={() => handleSignIn('github')}
          >
            Continue with GitHub
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
