import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeaderAccountMenu } from './HeaderAccountMenu';
import { MockDataSource } from '../lib/data/MockDataSource';
import { renderWithProviders } from '../test/renderWithProviders';
import type { Capabilities } from '../lib/data/DataSource';

/** A MockDataSource with fixed capability flags, so the chip / Admin link can be
 * exercised for each membership state. */
class CapsSource extends MockDataSource {
  constructor(private readonly caps: Capabilities) {
    super(`test-${Math.random()}`);
  }
  async getCapabilities(): Promise<Capabilities> {
    return this.caps;
  }
}

describe('HeaderAccountMenu — capability affordances', () => {
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  const openMenu = () => userEvent.setup().click(screen.getByLabelText('Account'));

  it('shows the FAMILY chip and Admin link for a family admin', async () => {
    renderWithProviders(<HeaderAccountMenu />, {
      source: new CapsSource({ family: true, admin: true, allowlistArmed: true }),
    });
    await openMenu();
    expect(await screen.findByText('FAMILY')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Admin' })).toBeInTheDocument();
  });

  it('hides the chip and Admin link for a non-family non-admin', async () => {
    renderWithProviders(<HeaderAccountMenu />, {
      source: new CapsSource({ family: false, admin: false, allowlistArmed: true }),
    });
    await openMenu();
    // The menu is open (Feeds is present) but neither affordance shows.
    await screen.findByRole('menuitem', { name: 'Feeds' });
    expect(screen.queryByText('FAMILY')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('shows the Admin link but no chip for an admin who isn’t on the allowlist', async () => {
    renderWithProviders(<HeaderAccountMenu />, {
      source: new CapsSource({ family: false, admin: true, allowlistArmed: true }),
    });
    await openMenu();
    expect(await screen.findByRole('menuitem', { name: 'Admin' })).toBeInTheDocument();
    expect(screen.queryByText('FAMILY')).not.toBeInTheDocument();
  });
});
