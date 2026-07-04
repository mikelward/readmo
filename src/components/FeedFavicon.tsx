import { useState, type CSSProperties } from 'react';
import { faviconNeedsDarkInvert } from '../lib/faviconInvert';
import { feedInitials } from '../lib/feedInitials';
import { avatarColorForString } from '../lib/avatarColor';

interface FeedFaviconProps {
  /** The favicon URL to show, or null/undefined when the poller hasn't
   * resolved one for this feed yet. */
  url: string | null | undefined;
  /** The feed's name. When the favicon is missing or fails to load, its
   * initials are drawn on a deterministic color badge instead of a blank box
   * (see feedInitials.ts). Omit only where a name isn't available — then the
   * old blank placeholder/collapse behavior applies. */
  name?: string | null;
  /** Base CSS class for surface-specific styling only — margins, border-radius,
   * `object-fit`, baseline nudge (e.g. `item-row__favicon`). It must NOT set the
   * box's width/height: the component owns those (see `size`) so a favicon and
   * its reserved placeholder can never disagree on size and jag the list. The
   * shared `favicon--invert-dark` class is appended automatically for
   * dark-monochrome marks (see faviconInvert.ts). */
  className: string;
  /** Rendered box size in px, applied here to both the `<img>` and the reserved
   * placeholder so they always match. Defaults to 16. */
  size?: number;
  /** `data-testid` for the rendered `<img>`, when a caller needs to target it. */
  testId?: string;
  /** Hold the icon's box even when there's no URL or it fails to load, so
   * adjacent text stays aligned with siblings whose icons did load. When off
   * (the default) a missing/failed icon collapses entirely. Ignored when an
   * initials badge is drawn (the badge fills the box either way). */
  reserveSpace?: boolean;
  /** CSS class for the reserved empty box, for surface-specific offset only
   * (again, not its size). Optional. */
  placeholderClassName?: string;
}

/** A feed's site favicon, rendered consistently across rows, headers, and
 * reader bars. Centralizes the box dimensions (so the icon and its placeholder
 * never drift out of sync), the per-domain dark-mode inversion class, and the
 * load-error handling: when the stored icon is missing or fails to load, it
 * draws a deterministic **initials-on-color badge** from the feed name (like the
 * account `UserAvatar` disc — offline, no favicon service) so a 404'd
 * `/favicon.ico` guess still leaves a recognizable mark instead of a blank box.
 * Only when there's no name to draw does it fall back to reserving/collapsing an
 * empty slot. Decorative — always `alt=""` / `aria-hidden`. */
export function FeedFavicon({
  url,
  name,
  className,
  size = 16,
  testId,
  reserveSpace = false,
  placeholderClassName,
}: FeedFaviconProps) {
  // The single source of truth for the box: the icon, its badge, and its stand-in
  // take their width/height from here, inline, so no per-surface CSS can size
  // them apart.
  const box: CSSProperties = { flex: '0 0 auto', width: size, height: size };

  // Track a stored-favicon load failure so we can swap to the initials badge.
  // Reset when the `url` prop changes — a recycled instance now showing a
  // different feed — via the render-phase "adjust state on prop change" pattern.
  const [imgFailed, setImgFailed] = useState(false);
  const [seenUrl, setSeenUrl] = useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    setImgFailed(false);
  }

  if (url && !imgFailed) {
    return (
      <img
        className={
          className + (faviconNeedsDarkInvert(url) ? ' favicon--invert-dark' : '')
        }
        style={box}
        src={url}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        data-testid={testId}
        // On error, fall through to the initials badge (or the blank placeholder
        // when there's no name) by re-rendering — no inline visibility juggling.
        onError={() => setImgFailed(true)}
      />
    );
  }

  // No loadable icon. Draw the feed's initials on a deterministic color badge
  // when we have a name; otherwise keep the old blank-slot behavior.
  const initials = feedInitials(name);
  if (initials) {
    return (
      <span
        className={className + ' favicon--initials'}
        // Layout-critical styles are inline so a surface class (item-row__favicon,
        // …) sharing the slot can never override the centering/color/size and
        // leave a mispainted badge; .favicon--initials adds the rest (radius, etc).
        style={{
          ...box,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: avatarColorForString(name ?? ''),
          color: '#fff',
          fontWeight: 700,
          lineHeight: 1,
          fontSize: Math.round(size * 0.5),
        }}
        aria-hidden="true"
        data-testid={testId}
      >
        {initials}
      </span>
    );
  }
  if (!reserveSpace) return null;
  // inline-block so the empty span honors width/height even outside a flex row
  // (an inline span would ignore them and collapse the reserved slot).
  return (
    <span
      className={placeholderClassName}
      style={{ ...box, display: 'inline-block' }}
      aria-hidden="true"
    />
  );
}
