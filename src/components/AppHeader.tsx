import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { Menu, Search } from './icons';
import { AppDrawer } from './AppDrawer';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import './AppHeader.css';

/** App header: drawer toggle (left), brand wordmark (center-left, links to
 * `/`), an Offline pill + Search glass + account chip (right). Present on
 * every page; the account chip is always-visible per SPEC.md *Auth*. */
export function AppHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const online = useOnlineStatus();

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <button
            type="button"
            className="app-header__icon-btn"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu />
          </button>

          <Link to="/" className="app-header__brand" aria-label="readmo home">
            readmo
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

          <HeaderAccountMenu />
        </div>
      </header>

      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
