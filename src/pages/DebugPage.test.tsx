import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { DebugPage } from './DebugPage';

describe('DebugPage', () => {
  it('renders build, backend mode, and the section headings', async () => {
    renderWithProviders(<DebugPage />, { route: '/debug' });

    expect(
      screen.getByRole('heading', { name: 'Debug', level: 1 }),
    ).toBeInTheDocument();
    // Section headings the diagnostics surface.
    for (const h of ['Build', 'Backend', 'Auth', 'DB connectivity']) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument();
    }
    // Unconfigured in tests → the mock backend is reported (so the DB pings are
    // skipped rather than throwing on getSupabase()).
    expect(screen.getByText('Mock (no env)')).toBeInTheDocument();
  });
});
