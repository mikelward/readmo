import { useEffect, useState } from 'react';
import { measureTopChromeHeight } from '../lib/stickyInset';

// The combined layout height of the top sticky chrome — the `<AppHeader>` plus
// the top `<ListToolbar>` (`.list-toolbar--top`). Group-by-feed section headers
// pin just below it (`position: sticky; top: …`), so they need this as their
// offset. The value can't be a fixed token: the top toolbar wraps to two rows
// on ultra-narrow phones (six icon buttons in the grouped view), which is
// exactly where the headers render — a hardcoded one-row offset would tuck a
// pinned header behind the wrapped toolbar. So we measure it.
//
// Unlike `useStickyInset`, this needs no scroll listener: `offsetHeight` is the
// element's layout height, independent of scroll position, so it only changes
// on a viewport resize or when the chrome itself reflows (toolbar wrap,
// safe-area change). Re-measures on mount, window resize, and a ResizeObserver
// on the two chrome strips; falls back gracefully where ResizeObserver is
// absent (jsdom).
export function useTopChromeHeight(): number {
  const [height, setHeight] = useState(() => measureTopChromeHeight());

  useEffect(() => {
    const update = () =>
      setHeight((prev) => {
        const next = measureTopChromeHeight();
        return prev === next ? prev : next;
      });
    update();
    window.addEventListener('resize', update);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      for (const selector of ['.app-header', '.list-toolbar--top']) {
        const el = document.querySelector(selector);
        if (el) ro.observe(el);
      }
    }
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, []);

  return height;
}
