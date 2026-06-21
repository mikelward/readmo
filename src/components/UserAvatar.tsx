import { avatarColorForString } from '../lib/avatarColor';
import './UserAvatar.css';

interface Props {
  name: string;
  avatarUrl: string | null;
  size?: number;
}

/** A 32px avatar: the OAuth provider's picture when present, else a
 * deterministic initial-on-color disc (offline, zero requests) — SPEC.md
 * *Auth → Account UI*. */
export function UserAvatar({ name, avatarUrl, size = 32 }: Props) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const bg = avatarColorForString(name);

  if (avatarUrl) {
    return (
      <img
        className="user-avatar"
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
      />
    );
  }

  return (
    <span
      className="user-avatar user-avatar--initial"
      style={{ width: size, height: size, background: bg }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
