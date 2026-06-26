import { Component, type ReactNode } from 'react';
import { reloadApp } from '../lib/reload';
import './LazyRouteBoundary.css';

const RELOAD_FLAG = 'readmo:chunk-reload';

function clearReloadFlag(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    // Storage blocked — nothing to clear.
  }
}

/** A lazily-loaded route lives in a content-hashed chunk. That chunk can go
 * missing after a deploy (a running client still references the previous hash)
 * or fail to fetch on a flaky network before the service worker has precached
 * it. `React.lazy` caches the rejected import, so without a boundary the route
 * blanks until a manual reload — a regression from the previous eager import,
 * which couldn't fail at navigation time. */
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /loading (chunk|dynamically imported module)|dynamically imported module|importing a module script failed|ChunkLoadError/i.test(
    `${error.name} ${error.message}`,
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/** Error boundary for lazy route chunks. On the first chunk-load failure it
 * reloads once — re-fetching index.html and the current chunk hashes fixes the
 * common stale-after-deploy case invisibly. A one-shot session flag guards
 * against a reload loop when the chunk is genuinely gone (truly missing asset,
 * or offline with nothing cached); in that case it falls back to a manual
 * retry. Class component because error boundaries require `componentDidCatch` —
 * there is no hook equivalent (the one sanctioned class in the codebase). */
export class LazyRouteBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidMount(): void {
    // The Suspense boundary sits above this one, so the boundary commits only
    // once its lazy children resolve — a successful mount (state not failed)
    // means the chunk loaded, so clear the one-shot guard. Without this the
    // guard would persist for the whole tab session and a later, unrelated
    // stale-chunk failure (e.g. after a subsequent deploy) would skip its own
    // auto-reload and drop straight to the manual UI.
    if (!this.state.failed) clearReloadFlag();
  }

  componentDidCatch(error: unknown): void {
    if (!isChunkLoadError(error)) return;
    // Auto-reload once to recover from a stale chunk. Web Storage can throw a
    // SecurityError in private/storage-blocked contexts; since we're already
    // inside an error handler, fail closed to the manual retry UI rather than
    // throw again — and without a persistable guard an auto-reload could loop.
    let alreadyReloaded = true;
    try {
      alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) !== null;
      if (!alreadyReloaded) sessionStorage.setItem(RELOAD_FLAG, '1');
    } catch {
      return;
    }
    if (!alreadyReloaded) reloadApp();
  }

  private readonly handleRetry = (): void => {
    // Clear the guard so this manual attempt gets a fresh auto-reload budget.
    clearReloadFlag();
    reloadApp();
  };

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="lazy-route-error" role="alert">
          <p className="lazy-route-error__text">This page couldn’t be loaded.</p>
          <button
            type="button"
            className="lazy-route-error__retry"
            onClick={this.handleRetry}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
