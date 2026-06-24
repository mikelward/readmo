import { Link } from 'react-router-dom';
import { Add } from './icons';
import './HomeEmptyCoach.css';

/** First-run coach shown on Home when the signed-in user has *no* subscriptions
 * at all. Distinct from the "You're all caught up." empty state — that one means
 * the user has feeds but nothing unread; this one points a brand-new user at the
 * Add-a-feed input in Settings so an empty Home isn't a dead end. */
export function HomeEmptyCoach() {
  return (
    <div className="home-coach" data-testid="home-empty-coach">
      <h2 className="home-coach__title">No feeds yet</h2>
      <p className="home-coach__body">
        Subscribe to a blog, news site, or podcast and its latest articles show
        up here. Pin one to read it offline.
      </p>
      <Link className="home-coach__cta" to="/settings">
        <Add className="home-coach__cta-icon" />
        Add a feed
      </Link>
    </div>
  );
}
