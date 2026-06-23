import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useHomeFeed } from '../hooks/useHomeFeed';
import { useTheme } from '../hooks/useTheme';
import type { Theme, Palette } from '../lib/theme';
import { TooltipButton } from './TooltipButton';
import './AppDrawer.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

const MS_VIEWBOX = '0 -960 960 960';

function ThemeIcon({ path }: { path: string }) {
  return (
    <svg viewBox={MS_VIEWBOX} fill="currentColor" width="22" height="22" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}

const LIGHT_PATH =
  'M480-360q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Zm0 80q-83 0-141.5-58.5T280-480q0-83 58.5-141.5T480-680q83 0 141.5 58.5T680-480q0 83-58.5 141.5T480-280ZM200-440H40v-80h160v80Zm720 0H760v-80h160v80ZM440-760v-160h80v160h-80Zm0 720v-160h80v160h-80ZM256-650l-101-97 57-59 96 100-52 56Zm492 496-97-101 53-55 101 97-57 59Zm-98-550 97-101 59 57-100 96-56-52ZM154-212l101-97 55 53-97 101-59-57Zm326-268Z';
const DARK_PATH =
  'M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 27.5 1t26.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 13 3 26.5t1 27.5q0 150-105 255T480-120Z';
const SYSTEM_PATH =
  'M80-120v-80h240v-80H160q-33 0-56.5-23.5T80-360v-400q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v400q0 33-23.5 56.5T800-280H640v80h240v80H80Zm80-240h640v-400H160v400Zm0 0v-400 400Z';

const THEME_OPTIONS: Array<{ value: Theme; label: string; path: string }> = [
  { value: 'light', label: 'Light', path: LIGHT_PATH },
  { value: 'dark', label: 'Dark', path: DARK_PATH },
  { value: 'system', label: 'System', path: SYSTEM_PATH },
];

const PALETTE_OPTIONS: Array<{ value: Palette; label: string }> = [
  { value: 'ink', label: 'Ink' },
  { value: 'turquoise', label: 'Turquoise' },
];

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
  const { theme, palette, setTheme, setPalette } = useTheme();

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
          <div className="app-drawer__heading">Appearance</div>
          <div className="app-drawer__segmented" role="radiogroup" aria-label="Mode">
            {THEME_OPTIONS.map((opt) => (
              <TooltipButton
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={theme === opt.value}
                tooltip={opt.label}
                aria-label={opt.label}
                className="app-drawer__segmented-btn"
                data-active={theme === opt.value || undefined}
                onClick={(e) => { e.stopPropagation(); setTheme(opt.value); }}
              >
                <ThemeIcon path={opt.path} />
              </TooltipButton>
            ))}
          </div>
          <div className="app-drawer__segmented" role="radiogroup" aria-label="Palette">
            {PALETTE_OPTIONS.map((opt) => (
              <TooltipButton
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={palette === opt.value}
                tooltip={opt.label}
                aria-label={opt.label}
                className="app-drawer__segmented-btn app-drawer__segmented-btn--text"
                data-active={palette === opt.value || undefined}
                onClick={(e) => { e.stopPropagation(); setPalette(opt.value); }}
              >
                {opt.label}
              </TooltipButton>
            ))}
          </div>
        </div>

        <div className="app-drawer__section">
          <div className="app-drawer__heading">Home feed</div>
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
