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

  it('lists the environment and commit from the build info', () => {
    renderWithProviders(<DebugPage />, { route: '/debug' });
    expect(screen.getByText('Environment')).toBeInTheDocument();
    expect(screen.getByText('Commit')).toBeInTheDocument();
    // The short SHA appears as its own row value (the summary line is a
    // single distinct text node, "main 42 (abc1234)").
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });
});
