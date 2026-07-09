import { reloadApp } from './reload';

// Recovery for the "blank page on the first load after a deploy" failure. With
// `registerType: 'autoUpdate'` (skipWaiting + clientsClaim + cleanupOutdatedCaches)
// there's a brief window where the service worker hands a tab a stale
// `index.html` that references the *previous* build's content-hashed entry
// (`/assets/index-<oldhash>.js`). That hash no longer exists in the current
// deployment, so the request misses the precache and falls through to the
// network, where the SPA host answers 404 (or, worse, rewrites it to the HTML
// shell). Either way the entry module never evaluates and the page paints
// empty — and because it's the entry itself that failed, no React error
// boundary is even alive to catch it. A manual refresh pulls the current
// `index.html` (whose hashes exist) and recovers; this module automates that
// refresh so the user never sees the blank.
//
// Three cooperating surfaces auto-reload once, split across TWO session-scoped
// budgets keyed by what "resolved" means for each — so a reload can never loop:
//
//   * The inline boot guard in `index.html` (the only code that runs before the
//     entry, so the only thing that can catch the *entry* failing) spends the
//     ENTRY budget. A successful boot proves the entry loaded, so `main.tsx`
//     clears the entry budget the moment this module evaluates — which re-arms
//     recovery for a tab kept open across a second deploy, while staying
//     loop-safe (a boot only happens when the entry actually loaded; a
//     permanently-broken entry never boots, so the budget is never cleared and
//     the one reload stands).
//   * The runtime listeners installed here (post-boot dynamic-import/preload
//     failures) and `LazyRouteBoundary` (a lazy route chunk failing during React
//     render) spend the CHUNK budget. A boot does NOT prove a still-failing lazy
//     chunk recovered, so this budget resets only when a lazy route mounts
//     successfully (`LazyRouteBoundary.componentDidMount` → `clearChunkReloadGuard`).
//     Clearing it on boot instead would loop the reload for a genuinely-gone
//     chunk (offline / broken deploy) whose route re-renders right after boot.
//
// The inline boot guard's listener is installed for the tab's lifetime, so
// clearing the entry budget on boot alone would let it loop on a *post-boot*
// /assets/ failure (a lazy route's chunk or CSS 404ing after a broken deploy):
// every boot clears the budget, every failure spends it and reloads. To keep
// the entry budget strictly pre-boot, `clearEntryReloadGuard` also sets
// `window.__readmoBooted`, which the inline guard checks before acting —
// post-boot asset failures are the CHUNK budget's job (it fails closed).
// `sessionStorage` scoping means each fresh app open starts with both clean.

/** Session-scoped one-shot guard key for post-boot chunk failures (lazy route
 * chunks, runtime dynamic imports). The entry-load budget is separate
 * (`ENTRY_RELOAD_GUARD_KEY`) because a successful boot resolves it but not this. */
export const CHUNK_RELOAD_GUARD_KEY = 'readmo:chunk-reload';

/** Session-scoped one-shot guard key for an entry-script load failure. Cleared
 * by `main.tsx` on a successful boot. Kept in sync with the inline boot guard in
 * `index.html`, which hard-codes the same string (it runs before any module can
 * load, so it can't import this constant). */
export const ENTRY_RELOAD_GUARD_KEY = 'readmo:entry-reload';

/** True for the family of errors thrown when a content-hashed JS/CSS chunk
 * can't be loaded after a deploy (old hash 404s, or is served the SPA HTML
 * fallback) or fails to fetch on a flaky network before the worker precached
 * it. Covers React.lazy's dynamic-import rejection, the browser's module-script
 * MIME/parse failure when HTML is served in place of JS, and Vite/Workbox
 * preload errors. */
export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === 'string'
        ? error
        : '';
  return /loading (chunk|dynamically imported module)|dynamically imported module|importing a module script failed|error loading dynamically imported module|expected a javascript module script|ChunkLoadError/i.test(
    message,
  );
}

/** Reset the post-boot chunk budget. Called when a lazy route mounts
 * successfully (the failed chunk has resolved) so a later deploy's stale-chunk
 * failure gets its own auto-reload. Never throws. */
export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {
    // Storage blocked (private mode / disabled) — nothing to clear.
  }
}

declare global {
  interface Window {
    /** Set on a successful boot; the inline boot guard in `index.html` checks
     * it and stands down, leaving post-boot asset failures to the CHUNK
     * budget. Hard-coded there (it runs before any module can load). */
    __readmoBooted?: boolean;
  }
}

/** Reset the entry-load budget. Called from `main.tsx` on a successful boot: the
 * entry evaluated, so a stale-entry failure it may have recovered from is
 * resolved, and a second stale entry later in the same session should auto-reload
 * again. Also marks the app booted so the inline boot guard (whose listener
 * lives for the whole tab) stops reacting to post-boot asset failures — with
 * the budget cleared each boot, it would otherwise reload in a loop for a
 * persistently failing lazy chunk. Never throws. */
export function clearEntryReloadGuard(): void {
  if (typeof window !== 'undefined') window.__readmoBooted = true;
  try {
    sessionStorage.removeItem(ENTRY_RELOAD_GUARD_KEY);
  } catch {
    // Storage blocked (private mode / disabled) — nothing to clear.
  }
}

/**
 * Reload once to recover from a stale chunk, at most once per session budget.
 * Returns `true` if it triggered the reload, `false` if the budget was already
 * spent or storage is unavailable — in which case the caller should fall back
 * to a manual retry rather than risk a reload loop.
 */
export function reloadOnceForChunkError(
  reload: () => void = reloadApp,
): boolean {
  let alreadyReloaded: boolean;
  try {
    alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) !== null;
    if (!alreadyReloaded) sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
  } catch {
    // Without a persistable guard an auto-reload could loop, so fail closed.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

// `vite:preloadError` (dispatched on `window` when a dynamically-imported module
// fails to preload) is typed by vite/client's WindowEventMap augmentation.

function isHashedAssetElement(target: EventTarget | null): boolean {
  if (target instanceof HTMLScriptElement) return /\/assets\//.test(target.src);
  if (target instanceof HTMLLinkElement) return /\/assets\//.test(target.href);
  return false;
}

/**
 * Install window-level listeners that auto-recover from a stale-chunk failure
 * surfacing OUTSIDE a React error boundary once the app is running: a failed
 * module preload (`vite:preloadError`), an uncaught dynamic-import rejection,
 * or a resource `error` on a hashed `/assets/` script/style. Complements
 * `LazyRouteBoundary` (React-render failures on the lazy `/feeds` route) and the
 * inline boot guard in `index.html` (the entry script, which fails before this
 * code runs). Returns a disposer that removes the listeners (used by tests;
 * production installs once for the tab's lifetime).
 */
export function installGlobalChunkReloadGuard(): () => void {
  if (typeof window === 'undefined') return () => {};

  const onPreloadError = (event: Event): void => {
    // Suppress Vite's default (which rethrows) so we own the recovery.
    event.preventDefault();
    reloadOnceForChunkError();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (isChunkLoadError(event.reason)) reloadOnceForChunkError();
  };
  const onError = (event: ErrorEvent): void => {
    if (
      isHashedAssetElement(event.target) ||
      isChunkLoadError(event.error) ||
      isChunkLoadError(event.message)
    ) {
      reloadOnceForChunkError();
    }
  };

  window.addEventListener('vite:preloadError', onPreloadError);
  window.addEventListener('unhandledrejection', onRejection);
  // Capture phase: resource-load errors on script/link elements don't bubble.
  window.addEventListener('error', onError, true);

  return () => {
    window.removeEventListener('vite:preloadError', onPreloadError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('error', onError, true);
  };
}
