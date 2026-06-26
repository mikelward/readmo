import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
import { BrandMark, Menu, Search, Settings } from './icons';
import { AppDrawer } from './AppDrawer';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import { TooltipButton } from './TooltipButton';
import './AppHeader.css';

/** App header: drawer toggle pinned to the viewport's left edge, brand
 * mark + wordmark and the Offline pill / Search glass inside a centered
 * inner (720px, widening toward `.app-main`'s 860px at ≥960px — clamped to
 * reserve edge gutter, so it reaches the full column-aligned 860px once the
 * viewport clears ~1060px), and the account chip
 * pinned to the viewport's right edge. Present on every page; the account
 * chip is always-visible per SPEC.md *Auth*. */
export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const status = useConnectivityStatus();
  const navigate = useNavigate();

  return (
    <>
      <header className="app-header">
        <TooltipButton
          type="button"
          className="app-header__icon-btn app-header__edge app-header__edge--left"
          tooltip="Menu"
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu />
        </TooltipButton>

        <div className="app-header__inner">
          <Link to="/" className="app-header__brand" aria-label="readmo home">
            <BrandMark className="app-header__brand-mark" />
            <span className="app-header__brand-text">readmo</span>
          </Link>

          <div className="app-header__spacer" />

          {status !== 'online' ? (
            <Link
              to="/offline"
              className="app-header__offline-pill"
              data-testid="offline-pill"
              // "Down" = device is connected but our backend isn't answering;
              // "Offline" = the device itself has no network. Both link to the
              // cached-content view (the only thing readable either way).
              title={
                status === 'backend-unreachable'
                  ? "Readmo's server isn't responding right now"
                  : 'You appear to be offline'
              }
            >
              {status === 'backend-unreachable' ? 'Down' : 'Offline'}
            </Link>
          ) : null}

          <TooltipButton
            type="button"
            className="app-header__icon-btn"
            tooltip="Search"
            aria-label="Search"
            onClick={() => navigate('/search')}
          >
            <Search />
          </TooltipButton>

          <TooltipButton
            type="button"
            className="app-header__icon-btn"
            tooltip="Settings"
            aria-label="Settings"
            onClick={() => navigate('/settings')}
          >
            <Settings />
          </TooltipButton>
        </div>

        <div className="app-header__edge app-header__edge--right">
          <HeaderAccountMenu />
        </div>
      </header>

      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
