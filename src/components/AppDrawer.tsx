import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useHomeFeed } from '../hooks/useHomeFeed';
import './AppDrawer.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

const PRIMARY_LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/pinned', label: 'Pinned' },
  { to: '/favorites', label: 'Favorites' },
  { to: '/done', label: 'Done' },
  { to: '/hidden', label: 'Hidden' },
  { to: '/opened', label: 'Opened' },
  { to: '/offline', label: 'Offline' },
  { to: '/settings', label: 'Settings' },
];

/** Navigation drawer. Holds the primary nav, the per-folder feed list, and
 * the Home picker (swaps what `/` renders without changing the URL). The
 * drawer is navigation-only — the account chip lives in the header. */
export function AppDrawer({ open, onClose }: Props) {
  const ds = useDataSource();
  const { homeFeed, setHomeFeed } = useHomeFeed();

  const { data: folders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: () => ds.getFolders(),
  });
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
          {PRIMARY_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                'app-drawer__link' + (isActive ? ' app-drawer__link--active' : '')
              }
            >
              {l.label}
            </NavLink>
          ))}
        </div>

        <div className="app-drawer__section">
          <div className="app-drawer__heading">Home shows</div>
          <button
            type="button"
            className={
              'app-drawer__link app-drawer__link--button' +
              (homeFeed.kind === 'all' ? ' app-drawer__link--active' : '')
            }
            onClick={(e) => {
              e.stopPropagation();
              setHomeFeed({ kind: 'all' });
            }}
          >
            All subscriptions
          </button>
          {folders.map((f) => (
            <button
              key={f.name}
              type="button"
              className={
                'app-drawer__link app-drawer__link--button' +
                (homeFeed.kind === 'folder' && homeFeed.name === f.name
                  ? ' app-drawer__link--active'
                  : '')
              }
              onClick={(e) => {
                e.stopPropagation();
                setHomeFeed({ kind: 'folder', name: f.name });
              }}
            >
              {f.name}
            </button>
          ))}
        </div>

        <div className="app-drawer__section">
          <div className="app-drawer__heading">Folders</div>
          {folders.map((f) => (
            <NavLink
              key={f.name}
              to={`/folder/${encodeURIComponent(f.name)}`}
              className="app-drawer__link"
            >
              {f.name}
            </NavLink>
          ))}
        </div>

        <div className="app-drawer__section">
          <div className="app-drawer__heading">Feeds</div>
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
      </nav>
    </div>
  );
}
