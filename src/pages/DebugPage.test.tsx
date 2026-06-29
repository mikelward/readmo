import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { DebugPage } from './DebugPage';

describe('DebugPage', () => {
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

  it('omits the live Supabase reachability row in mock mode', () => {
    // Tests run unconfigured (no Supabase env vars), so there's no backend to
    // probe; the Configuration section already reports "mock data". The
    // reachable/latency probe path is unit-tested in supabaseHealth.test.ts.
    renderWithProviders(<DebugPage />, { route: '/debug' });
    expect(screen.queryByText(/reachable|checking/)).not.toBeInTheDocument();
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
