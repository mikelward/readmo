import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { UserAvatar } from './UserAvatar';
import './HeaderAccountMenu.css';

/** Header account chip (far right, every page). Signed out → a "Sign in"
 * link; signed in → a 32px avatar that opens a small popover with the
 * display name, a settings link, and Sign out (SPEC.md *Auth → Account UI*). */
export function HeaderAccountMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) {
    return (
      <Link to="/signin" className="account-chip account-chip--signin">
        Sign in
      </Link>
    );
  }

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        type="button"
        className="account-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        onClick={() => setOpen((o) => !o)}
      >
        <UserAvatar name={user.name} avatarUrl={user.avatarUrl} />
      </button>
      {open ? (
        <div className="account-menu__popover" role="menu">
          <div className="account-menu__identity">
            <div className="account-menu__name">{user.name}</div>
            <div className="account-menu__email">{user.email}</div>
          </div>
          <Link
            to="/settings"
            role="menuitem"
            className="account-menu__item"
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            className="account-menu__item"
            onClick={() => {
              setOpen(false);
              signOut();
              navigate('/signin');
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
