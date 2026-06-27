import { Link } from 'react-router-dom';
import './AboutPage.css';

export function AboutPage() {
  return (
    <article className="about-page">
      <h1 className="about-page__title">About Readmo</h1>
      <p>
        Readmo is a mobile-first reader for the RSS, Atom, and JSON feeds you
        subscribe to, by{' '}
        <a
          href="https://mikelward.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          Mikel Ward
        </a>
        . Add the sites you follow and Readmo polls them for you, then lets you
        triage articles with a clean, chronological feed &mdash; pin what you
        want to read, favorite what you want to keep, and mark the rest done.
      </p>

      <h2 className="about-page__heading">Your feeds, synced and offline</h2>
      <p>
        Your subscriptions, reading list, and progress are tied to your account
        and sync across every device you sign in on. Recently read items are
        cached on your device so the feeds you follow stay readable even when
        you&rsquo;re offline.
      </p>

      <h2 className="about-page__heading">Where the content comes from</h2>
      <p>
        Articles come from the feeds published by the sites you subscribe to.
        Readmo fetches and renders that syndicated content and always links back
        to the original article. All posts remain the work and property of their
        respective publishers; Readmo is independent and not affiliated with any
        of them.
      </p>

      <p className="about-page__back">
        <Link to="/">&larr; Back to Home</Link>
      </p>
    </article>
  );
}
