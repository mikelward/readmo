import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { AppDrawer } from './AppDrawer';

function renderDrawer(open = true) {
  const onClose = vi.fn();
  const result = renderWithProviders(<AppDrawer open={open} onClose={onClose} />);
  return { onClose, ...result };
}

describe('AppDrawer', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('renders nothing when closed', () => {
    renderDrawer(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the navigation section headings when open', () => {
    renderDrawer();
    const headings = Array.from(
      screen.getByRole('dialog').querySelectorAll('.app-drawer__heading'),
    ).map((el) => el.textContent);
    expect(headings).toContain('Home');
    expect(headings).toContain('Library');
    expect(headings).toContain('Feeds');
    expect(headings).toContain('Appearance');
    expect(headings).toContain('App');
  });

  it('shows the Dark/Light mode and Text size pickers but not the color-theme picker', () => {
    renderDrawer();
    expect(
      screen.getByRole('radiogroup', { name: 'Dark/Light mode' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Text size' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument();
    // The text size is a readout on the stepper now, not one radio per rung.
    // No stored size, so this is the default.
    expect(screen.getByText('16px')).toBeInTheDocument();
    // Color Theme (palette) stays in Settings.
    expect(screen.queryByRole('radiogroup', { name: 'Color theme' })).toBeNull();
  });

  it('offers the text-size stepper in the drawer', () => {
    renderDrawer();
    // A stepper is a fixed three controls however long the ladder is, so the
    // narrow drawer panel needs no layout variant of its own.
    const group = screen.getByRole('group', { name: 'Text size' });
    expect(group).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Smaller text' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Larger text' }),
    ).toBeInTheDocument();
  });

  it('has an App section linking to Settings, About, and Legal (Debug lives on About)', () => {
    renderDrawer();
    expect(screen.getByText('App')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute(
      'href',
      '/about',
    );
    expect(screen.getByRole('link', { name: 'Legal' })).toHaveAttribute(
      'href',
      '/legal',
    );
    // Debug is reached from the About page now, not the drawer.
    expect(screen.queryByRole('link', { name: 'Debug' })).toBeNull();
  });

  it('orders the sections Home, Library, Feeds, Appearance, App', () => {
    renderDrawer();
    const headings = Array.from(
      screen.getByRole('dialog').querySelectorAll('.app-drawer__heading'),
    ).map((el) => el.textContent);
    expect(headings).toEqual(['Home', 'Library', 'Feeds', 'Appearance', 'App']);
  });

  it('no longer shows the Home feed picker or a Folders section (dropped — TODO to restore)', () => {
    renderDrawer();
    // The "All subscriptions" / per-folder home-feed picker buttons are gone…
    expect(screen.queryByText('All subscriptions')).toBeNull();
    // …and there's no Folders nav section.
    const headings = Array.from(
      screen.getByRole('dialog').querySelectorAll('.app-drawer__heading'),
    ).map((el) => el.textContent);
    expect(headings).not.toContain('Folders');
    // The Home section keeps only the Home link.
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  });

  it('exposes an edit pencil beside the Feeds heading linking to /feeds', () => {
    renderDrawer();
    const editLink = screen.getByRole('link', { name: 'Edit feeds' });
    expect(editLink).toHaveAttribute('href', '/feeds');
  });

  it('calls onClose when backdrop is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDrawer();
    await user.click(screen.getByRole('dialog').querySelector('.app-drawer__backdrop')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose on Escape key', async () => {
    const { onClose } = renderDrawer();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
