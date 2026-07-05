import { Component, type ReactNode } from 'react';
import { reloadApp } from '../lib/reload';
import {
  clearChunkReloadGuard,
  isChunkLoadError,
  reloadOnceForChunkError,
} from '../lib/chunkReload';
import './LazyRouteBoundary.css';

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
    if (!this.state.failed) clearChunkReloadGuard();
  }

  componentDidCatch(error: unknown): void {
    // Auto-reload once to recover from a stale chunk, sharing the one-shot guard
    // with the boot/runtime guards so recovery can't loop. A non-chunk error, a
    // spent budget, or storage being blocked all leave the manual retry UI up
    // (fail closed — we're already inside an error handler).
    if (isChunkLoadError(error)) reloadOnceForChunkError();
  }

  private readonly handleRetry = (): void => {
    // Clear the guard so this manual attempt gets a fresh auto-reload budget.
    clearChunkReloadGuard();
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
