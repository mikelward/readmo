/** Full-page reload, guarded for non-browser (test/SSR) environments. Kept in
 * its own module so tests can mock it without redefining `window.location`
 * (which is non-configurable under jsdom). */
export function reloadApp(): void {
  try {
    if (typeof window !== 'undefined') window.location.reload();
  } catch {
    /* navigation unavailable (jsdom/SSR) */
  }
}
