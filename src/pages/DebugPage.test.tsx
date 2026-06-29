import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { DebugPage } from './DebugPage';
import { isSupabaseConfigured, supabaseHealthUrl } from '../lib/supabase/client';

// Mock the config accessors DebugPage/useAuth read so a test can simulate a
// partial config. Manual (not importOriginal) to avoid re-evaluating client.ts
// → buildInfo.ts, whose __BUILD_INFO__ define isn't applied inside a mock
// factory. Defaults mirror the real unconfigured test environment (false /
// null), so every other test behaves exactly as before.
vi.mock('../lib/supabase/client', () => ({
  isSupabaseConfigured: vi.fn(() => false),
  supabaseHealthUrl: vi.fn(() => null),
  getSupabase: vi.fn(),
  AUTH_STORAGE_KEY: 'readmo:sb-auth',
}));

describe('DebugPage', () => {
  afterEach(() => {
    vi.mocked(isSupabaseConfigured).mockReturnValue(false);
    vi.mocked(supabaseHealthUrl).mockReturnValue(null);
    vi.unstubAllGlobals();
  });

  it('shows the build summary from the injected build info', () => {
    // vite.config.ts injects TEST_BUILD_INFO under VITEST:
    // branch 'main', 42 commits, sha 'abc1234'.
    renderWithProviders(<DebugPage />, { route: '/debug' });
    expect(screen.getByText('main 42 (abc1234)')).toBeInTheDocument();
  });

  it('renders the build, runtime, configuration, and account sections', () => {
    renderWithProviders(<DebugPage />, { route: '/debug' });
    expect(screen.getByRole('heading', { name: 'Build' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Runtime' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Configuration' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
  });

  it('keeps the lean runtime rows but not browser-introspection noise', () => {
    renderWithProviders(<DebugPage />, { route: '/debug' });
    // Kept: the runtime signals that matter for a PWA reader.
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('Service worker')).toBeInTheDocument();
    // Trimmed: User agent, Viewport, and Display mode were removed as noise.
    expect(screen.queryByText('User agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Viewport')).not.toBeInTheDocument();
    expect(screen.queryByText('Display mode')).not.toBeInTheDocument();
  });

  it('always shows the Supabase row, neutral when unconfigured (mock mode)', () => {
    // Tests run unconfigured (no Supabase env vars): the row still appears with
    // a neutral "not configured" state rather than disappearing. The
    // reachable/latency probe path is unit-tested in supabaseHealth.test.ts.
    const { container } = renderWithProviders(<DebugPage />, { route: '/debug' });
    expect(screen.getByText('Supabase')).toBeInTheDocument();
    expect(screen.getByText('not configured (mock data)')).toBeInTheDocument();
    // Neutral badge, not a probe attempt.
    expect(screen.queryByText(/reachable|checking/)).not.toBeInTheDocument();
    expect(container.querySelector('.debug__badge[data-state="idle"]')).toBeTruthy();
  });

  it('stays neutral and does not probe when only partially configured', () => {
    // URL present but anon key missing → isSupabaseConfigured() is false (the app
    // is on mock data) even though a health URL exists. The probe must NOT fire,
    // or /debug would falsely report the backend as reachable. Regression for the
    // partial-config gap left when the Configuration presence row was removed.
    vi.mocked(supabaseHealthUrl).mockReturnValue('https://proj.supabase.co/auth/v1/health');
    vi.mocked(isSupabaseConfigured).mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<DebugPage />, { route: '/debug' });

    expect(screen.getByText('not configured (mock data)')).toBeInTheDocument();
    expect(screen.queryByText(/reachable|checking/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders glanceable status badges for Network and Supabase', () => {
    const { container } = renderWithProviders(<DebugPage />, { route: '/debug' });
    // jsdom reports navigator.onLine === true → green "ok" badge on Network.
    expect(container.querySelector('.debug__badge[data-state="ok"]')).toBeTruthy();
    // Every row reserves a badge slot for alignment, even status-less ones.
    expect(container.querySelectorAll('.debug__badge').length).toBeGreaterThan(0);
  });

  it('groups the badged status rows together at the top of Runtime', () => {
    renderWithProviders(<DebugPage />, { route: '/debug' });
    const runtime = screen
      .getByRole('heading', { name: 'Runtime' })
      .closest('.debug__section') as HTMLElement;
    const labels = Array.from(
      runtime.querySelectorAll('.debug__label'),
    ).map((dt) => dt.textContent?.trim());
    // The three badged status rows are contiguous, ahead of the informational
    // rows (Language / Time zone).
    expect(labels.slice(0, 3)).toEqual(['Network', 'Service worker', 'Supabase']);
    expect(labels.indexOf('Language')).toBeGreaterThan(labels.indexOf('Supabase'));
  });

  it('drops the per-device Theme and Palette rows from Account', () => {
    renderWithProviders(<DebugPage />, { route: '/debug' });
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.queryByText('Theme')).not.toBeInTheDocument();
    expect(screen.queryByText('Palette')).not.toBeInTheDocument();
  });

  it('lists the environment and commit from the build info', () => {
    renderWithProviders(<DebugPage />, { route: '/debug' });
    expect(screen.getByText('Environment')).toBeInTheDocument();
    expect(screen.getByText('Commit')).toBeInTheDocument();
    // The short SHA appears as its own row value (the summary line is a
    // single distinct text node, "main 42 (abc1234)").
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });
});
