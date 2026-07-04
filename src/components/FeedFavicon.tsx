import type { CSSProperties } from 'react';
import { faviconNeedsDarkInvert } from '../lib/faviconInvert';

interface FeedFaviconProps {
  /** The favicon URL to show, or null/undefined when the poller hasn't
   * resolved one for this feed yet. */
  url: string | null | undefined;
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
   * (the default) a missing/failed icon collapses entirely. */
  reserveSpace?: boolean;
  /** CSS class for the reserved empty box, for surface-specific offset only
   * (again, not its size). Optional. */
  placeholderClassName?: string;
}

/** A feed's site favicon, rendered consistently across rows, headers, and
 * reader bars. Centralizes the four things every call site used to repeat: the
 * box dimensions (so the icon and its placeholder never drift out of sync), the
 * per-domain dark-mode inversion class, hiding the `<img>` on a load error so a
 * 404'd `/favicon.ico` guess leaves no broken-image glyph, and (optionally)
 * reserving the icon's box so a missing/invalid icon doesn't yank neighboring
 * text out of alignment. Decorative — always `alt=""` / `aria-hidden`. */
export function FeedFavicon({
  url,
  className,
  size = 16,
  testId,
  reserveSpace = false,
  placeholderClassName,
}: FeedFaviconProps) {
  // The single source of truth for the box: the icon and its stand-in take their
  // width/height from here, inline, so no per-surface CSS can size them apart.
  const box: CSSProperties = { flex: '0 0 auto', width: size, height: size };
  if (url) {
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
        onError={(e) => {
          // Keep the box (visibility) where the layout reserves space for it so
          // sibling text doesn't snap over; otherwise collapse it (display).
          if (reserveSpace) e.currentTarget.style.visibility = 'hidden';
          else e.currentTarget.style.display = 'none';
        }}
      />
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
