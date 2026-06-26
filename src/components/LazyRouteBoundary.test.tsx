import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LazyRouteBoundary } from './LazyRouteBoundary';
import { reloadApp } from '../lib/reload';

// Mock the reload seam (jsdom's window.location is non-configurable, so the
// codebase routes reloads through this module precisely so tests can stub it).
vi.mock('../lib/reload', () => ({ reloadApp: vi.fn() }));
const reload = vi.mocked(reloadApp);

/** Throws on first render with a chosen error, to simulate a lazy chunk that
 * fails to load underneath the boundary. */
function Boom({ error }: { error: Error }): never {
  throw error;
}

const chunkError = () =>
  new Error('Failed to fetch dynamically imported module: /assets/SettingsPage-abc123.js');

describe('LazyRouteBoundary', () => {
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
    // Error boundaries log the caught error; keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <LazyRouteBoundary>
        <div>settings content</div>
      </LazyRouteBoundary>,
    );
    expect(screen.getByText('settings content')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('clears a stale reload guard once the route mounts successfully', () => {
    // A previous recovery left the guard set; a successful mount must clear it
    // so a later, unrelated chunk failure gets its own auto-reload budget.
    sessionStorage.setItem('readmo:chunk-reload', '1');
    render(
      <LazyRouteBoundary>
        <div>settings content</div>
      </LazyRouteBoundary>,
    );
    expect(screen.getByText('settings content')).toBeInTheDocument();
    expect(sessionStorage.getItem('readmo:chunk-reload')).toBeNull();
  });

  it('auto-reloads once on a chunk-load error', () => {
    render(
      <LazyRouteBoundary>
        <Boom error={chunkError()} />
      </LazyRouteBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('readmo:chunk-reload')).toBe('1');
  });

  it('does not auto-reload a second time (guards against a reload loop)', () => {
    sessionStorage.setItem('readmo:chunk-reload', '1');
    render(
      <LazyRouteBoundary>
        <Boom error={chunkError()} />
      </LazyRouteBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();
    // Falls back to a manual retry instead.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('fails closed to the manual fallback when storage is blocked', () => {
    // Private/storage-disabled contexts throw on Web Storage access. The
    // recovery path runs inside componentDidCatch, so it must not throw again.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is disabled');
    });
    render(
      <LazyRouteBoundary>
        <Boom error={chunkError()} />
      </LazyRouteBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('does not auto-reload on a non-chunk error', () => {
    render(
      <LazyRouteBoundary>
        <Boom error={new Error('some render bug')} />
      </LazyRouteBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('manual retry clears the guard and reloads', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem('readmo:chunk-reload', '1');
    render(
      <LazyRouteBoundary>
        <Boom error={chunkError()} />
      </LazyRouteBoundary>,
    );
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(sessionStorage.getItem('readmo:chunk-reload')).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
