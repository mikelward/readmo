import { useState } from 'react';
import { avatarColorForString } from '../lib/avatarColor';
import './UserAvatar.css';

interface Props {
  name: string;
  avatarUrl: string | null;
  size?: number;
}

/** A 32px avatar: a deterministic initial-on-color disc (offline, zero
 * requests) with the OAuth provider's picture layered on top when present.
 * The picture fades in on load so a slow network doesn't flash the letter
 * then snap to a face; if it 404s or fails to load it's unmounted and the
 * initial underneath is already visible — no broken-image glyph, no layout
 * shift (ported from newshacker). Load/fail state is keyed to the URL, so a
 * changed picture retries even after an earlier one failed. SPEC.md *Auth →
 * Account UI*. */
export function UserAvatar({ name, avatarUrl, size = 32 }: Props) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const bg = avatarColorForString(name);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const showImage = Boolean(avatarUrl) && failedUrl !== avatarUrl;

  return (
    <span
      className="user-avatar user-avatar--initial"
      style={{ width: size, height: size, background: bg }}
      data-testid="user-avatar"
      aria-hidden="true"
    >
      {initial}
      {showImage ? (
        <img
          className="user-avatar__img"
          src={avatarUrl ?? undefined}
          alt=""
          aria-hidden="true"
          data-testid="user-avatar-img"
          data-loaded={loadedUrl === avatarUrl ? 'true' : 'false'}
          onLoad={() => setLoadedUrl(avatarUrl)}
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : null}
    </span>
  );
}
