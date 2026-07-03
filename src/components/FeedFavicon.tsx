import type { CSSProperties } from 'react';
import { faviconNeedsDarkInvert } from '../lib/faviconInvert';

interface FeedFaviconProps {
  /** The favicon URL to show, or null/undefined when the poller hasn't
   * resolved one for this feed yet. */
  url: string | null | undefined;
  /** Base CSS class carrying the icon's size/position for this surface (e.g.
   * `item-row__favicon`). The shared `favicon--invert-dark` class is appended
   * automatically for dark-monochrome marks (see faviconInvert.ts). */
  className: string;
  /** Rendered box size in px; also the intrinsic width/height attributes so a
   * slow/large source doesn't shift the layout while it loads. Defaults to 16. */
  size?: number;
  /** `data-testid` for the rendered `<img>`, when a caller needs to target it. */
  testId?: string;
  /** Hold the icon's box even when there's no URL or it fails to load, so
   * adjacent text stays aligned with siblings whose icons did load. When off
   * (the default) a missing/failed icon collapses entirely. */
  reserveSpace?: boolean;
  /** CSS class for the reserved empty box when `reserveSpace` is set and there's
   * no URL. Falls back to an inline square matching `size` when omitted. */
  placeholderClassName?: string;
}

/** A feed's site favicon, rendered consistently across rows, headers, and
 * reader bars. Centralizes the three things every call site used to repeat: the
 * per-domain dark-mode inversion class, hiding the `<img>` on a load error so a
 * 404'd `/favicon.ico` guess leaves no broken-image glyph, and (optionally)
 * reserving the icon's box so a missing icon doesn't yank neighboring text out
 * of alignment. Decorative — always `alt=""` / `aria-hidden`. */
export function FeedFavicon({
  url,
  className,
  size = 16,
  testId,
  reserveSpace = false,
  placeholderClassName,
}: FeedFaviconProps) {
  if (url) {
    return (
      <img
        className={
          className + (faviconNeedsDarkInvert(url) ? ' favicon--invert-dark' : '')
        }
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
  const style: CSSProperties | undefined = placeholderClassName
    ? undefined
    : { display: 'inline-block', flex: '0 0 auto', width: size, height: size };
  return (
    <span className={placeholderClassName} style={style} aria-hidden="true" />
  );
}
