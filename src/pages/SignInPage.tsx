import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import './SignInPage.css';

/** Clean sign-in landing (SPEC.md *Auth*). PR1 wires mock OAuth buttons that
 * sign in immediately; PR2 swaps these for Supabase Google/GitHub OAuth. */
export function SignInPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  useDocumentTitle('Sign in · readmo');

  const handleSignIn = () => {
    signIn();
    navigate('/');
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
          <button type="button" className="signin__btn" onClick={handleSignIn}>
            Continue with Google
          </button>
          <button type="button" className="signin__btn" onClick={handleSignIn}>
            Continue with GitHub
          </button>
        </div>
        <p className="signin__privacy">
          We use your sign-in only to sync your subscriptions and reading state.
          We never post on your behalf. (Demo mode — no real account is created.)
        </p>
      </div>
    </div>
  );
}
