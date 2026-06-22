import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { BrandMark, Menu, Search } from './icons';
import { AppDrawer } from './AppDrawer';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import './AppHeader.css';

/** App header: drawer toggle pinned to the viewport's left edge, brand
 * mark + wordmark and the Offline pill / Search glass inside a 720px
 * centered inner (aligned with the article column), and the account chip
 * pinned to the viewport's right edge. Present on every page; the account
 * chip is always-visible per SPEC.md *Auth*. */
export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const online = useOnlineStatus();

  return (
    <>
      <header className="app-header">
        <button
          type="button"
          className="app-header__icon-btn app-header__edge app-header__edge--left"
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu />
        </button>

        <div className="app-header__inner">
          <Link to="/" className="app-header__brand" aria-label="readmo home">
            <BrandMark className="app-header__brand-mark" />
            <span className="app-header__brand-text">readmo</span>
          </Link>

          <div className="app-header__spacer" />

          {!online ? (
            <Link
              to="/offline"
              className="app-header__offline-pill"
              data-testid="offline-pill"
            >
              Offline
            </Link>
          ) : null}

          <Link
            to="/search"
            className="app-header__icon-btn"
            aria-label="Search"
          >
            <Search />
          </Link>
        </div>

        <div className="app-header__edge app-header__edge--right">
          <HeaderAccountMenu />
        </div>
      </header>

      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
