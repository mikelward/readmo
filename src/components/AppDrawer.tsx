import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { Edit } from './icons';
import { ThemeModeControl } from './ThemeModeControl';
import { TextSizeControl } from './TextSizeControl';
import './AppDrawer.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

const LIBRARY_LINKS = [
  { to: '/pinned', label: 'Pinned' },
  { to: '/favorites', label: 'Favorites' },
  { to: '/done', label: 'Done' },
  { to: '/opened', label: 'Opened' },
  { to: '/offline', label: 'Offline' },
];

/** Navigation drawer — Home, Library, Feeds (with an edit affordance linking to
 * the Feeds management page), an Appearance section with the Dark/Light mode
 * and Text size pickers (the most-changed settings, one tap from anywhere), and
 * an App section with Settings, About, and Legal. The remaining appearance
 * controls (color theme, font) live in Settings; Debug is reached from the
 * About page. */
export function AppDrawer({ open, onClose }: Props) {
  const ds = useDataSource();

  const { data: subs = [] } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="app-drawer" role="dialog" aria-label="Navigation" aria-modal="true">
      <div className="app-drawer__backdrop" onClick={onClose} />
      <nav className="app-drawer__panel" onClick={onClose}>

        <div className="app-drawer__section">
          <div className="app-drawer__heading">Home</div>
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              'app-drawer__link' + (isActive ? ' app-drawer__link--active' : '')
            }
          >
            Home
          </NavLink>
          {/* TODO: restore the Home feed picker (All subscriptions / per-folder)
              and a Folders nav section once home-feed switching and folder
              navigation are designed properly. Dropped from the drawer for now;
              `/` still renders the All-subscriptions river (useHomeFeed default). */}
        </div>

        <div className="app-drawer__section">
          <div className="app-drawer__heading">Library</div>
          {LIBRARY_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                'app-drawer__link' + (isActive ? ' app-drawer__link--active' : '')
              }
            >
              {l.label}
            </NavLink>
          ))}
        </div>

        <div className="app-drawer__section">
          <div className="app-drawer__heading-row">
            <div className="app-drawer__heading">Feeds</div>
            <NavLink
              to="/feeds"
              className="app-drawer__heading-action"
              aria-label="Edit feeds"
              title="Edit feeds"
            >
              <Edit width={20} height={20} />
            </NavLink>
          </div>
          {subs.map(({ feed, subscription }) => (
            <NavLink
              key={feed.id}
              to={`/feed/${feed.id}`}
              className="app-drawer__link app-drawer__link--feed"
            >
              <span className="app-drawer__feed-title">
                {subscription.titleOverride ?? feed.title}
              </span>
              {feed.parked ? (
                <span
                  className="app-drawer__health"
                  title={feed.lastError ?? 'Feed parked'}
                  aria-label="Feed has errors"
                >
                  !
                </span>
              ) : null}
            </NavLink>
          ))}
        </div>

        <div className="app-drawer__section">
          <div className="app-drawer__heading">Appearance</div>
          <div className="app-drawer__appearance">
            <ThemeModeControl />
            <TextSizeControl className="text-size--grid" />
          </div>
        </div>

        <div className="app-drawer__section">
          <div className="app-drawer__heading">App</div>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              'app-drawer__link' + (isActive ? ' app-drawer__link--active' : '')
            }
          >
            Settings
          </NavLink>
          <NavLink
            to="/about"
            className={({ isActive }) =>
              'app-drawer__link' + (isActive ? ' app-drawer__link--active' : '')
            }
          >
            About
          </NavLink>
          <NavLink
            to="/legal"
            className={({ isActive }) =>
              'app-drawer__link' + (isActive ? ' app-drawer__link--active' : '')
            }
          >
            Legal
          </NavLink>
        </div>

      </nav>
    </div>
  );
}
