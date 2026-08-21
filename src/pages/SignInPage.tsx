import { useMemo, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type OAuthProvider } from '../hooks/useAuth';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { isEmailAuthEnabled, isSupabaseConfigured } from '../lib/supabase/client';
import { ItemRow } from '../components/ItemRow';
import type { Feed, FeedItem, Item } from '../lib/types';
import './SignInPage.css';

interface FromState {
  from?: { pathname?: string; search?: string; hash?: string };
}

const HOUR = 60 * 60 * 1000;

/** The sign-in hero's decorative preview rows. Rendered through the REAL
 * `ItemRow` (wrapped `inert` below, so nothing here is actually tappable —
 * see SignInPage.tsx's render) rather than a hand-rolled meta-line string, so
 * the hero can never again drift from the real row's format/order the way it
 * once did (TODO.md *UI / layout*). `now` is threaded in rather than read
 * here so this stays a pure function of its input. r/popular sits in the
 * middle, not last: the bottom row is partly covered by the hero's fade
 * gradient, which would wash out its source/meta line. */
function buildDemoFeedItems(now: number): FeedItem[] {
  const feed = (id: string, title: string, siteUrl: string): Feed => ({
    id,
    url: siteUrl,
    siteUrl,
    title,
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
  });
  const item = (
    id: string,
    feedId: string,
    title: string,
    siteUrl: string,
    agoHours: number,
    categories: string[] = [],
  ): Item => ({
    id,
    feedId,
    guid: id,
    // Same site as the feed, so the real domain badge (only shown when an
    // article links off-site — see lib/itemMeta.ts's articleSourceDomain)
    // correctly stays hidden for these ordinary, non-aggregator posts. With
    // no domain, formatItemMetaTail's meta-line fallback slot shows the
    // article's own category instead (when one is given) — same behavior a
    // real category-carrying feed gets.
    url: `${siteUrl}/article`,
    commentsUrl: null,
    title,
    spoilerFreeTitle: null,
    author: null,
    publishedAt: now - agoHours * HOUR,
    contentHtml: '',
    summary: null,
    fullContentHtml: null,
    aiSummary: null,
    enclosures: [],
    categories,
  });

  const apNews = feed('demo-feed-ap', 'AP News', 'https://apnews.com');
  const reddit = feed('demo-feed-reddit', 'r/popular', 'https://reddit.com');
  const vox = feed('demo-feed-vox', 'Vox', 'https://vox.com');

  return [
    {
      item: item(
        'demo-item-1',
        apNews.id,
        'FDA Approves New Treatment for Common Form of Heart Disease',
        apNews.siteUrl!,
        1,
        ['Health'],
      ),
      feed: apNews,
    },
    {
      // Reddit's own RSS for an aggregate feed (r/popular, r/all) carries the
      // ORIGIN subreddit as the item's publisher category — not a topic tag —
      // so this fills the same real fallback slot the AP News/Vox rows do.
      item: item(
        'demo-item-2',
        reddit.id,
        'My Dad Just Retired After 40 Years — Proud of Him',
        reddit.siteUrl!,
        4,
        ['MadeMeSmile'],
      ),
      feed: reddit,
    },
    {
      item: item(
        'demo-item-3',
        vox.id,
        'Why Your Grocery Bill Keeps Going Up',
        vox.siteUrl!,
        3,
        ['Economy'],
      ),
      feed: vox,
    },
  ];
}

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
  // Computed once per mount (not re-derived from a ticking clock) — the hero
  // is decorative, not a live feed. Before the early `user` return below, so
  // this hook always runs (rules of hooks).
  const demoFeedItems = useMemo(() => buildDemoFeedItems(Date.now()), []);

  // Passwordless email sign-in is opt-in per deployment (VITE_EMAIL_AUTH_ENABLED);
  // when off, only the OAuth buttons show.
  const emailEnabled = isEmailAuthEnabled();

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
      {/* `inert` (not just aria-hidden) so the real ItemRow's real Link/pin
          button — genuinely wired to navigate to `/item/:id` and write item
          state — can never actually be tapped or focused here; this is a
          decorative preview, not a live list. */}
      <div className="signin__hero" aria-hidden="true" inert>
        <ul className="signin__mock-feed">
          {demoFeedItems.map((fi) => (
            <li key={fi.item.id}>
              <ItemRow feedItem={fi} enableSwipe={false} listLayout="title" />
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

            {emailEnabled && (
              <>
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
              </>
            )}

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
