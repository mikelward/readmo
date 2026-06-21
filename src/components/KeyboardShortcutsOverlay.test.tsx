import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { KeyboardShortcutsOverlay } from './KeyboardShortcutsOverlay';

function renderAt(route: string, ui: ReactNode) {
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
}

afterEach(() => {
  document
    .querySelectorAll('[data-test-cleanup]')
    .forEach((el) => el.remove());
});

describe('<KeyboardShortcutsOverlay>', () => {
  it('opens when the user presses `?`', async () => {
    renderAt('/', <KeyboardShortcutsOverlay />);
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
    await userEvent.keyboard('?');
    expect(
      screen.getByTestId('keyboard-shortcuts-overlay'),
    ).toBeInTheDocument();
  });

  it('closes when the user presses Escape, restoring focus', async () => {
    renderAt('/', <KeyboardShortcutsOverlay />);
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    trigger.setAttribute('data-test-cleanup', 'true');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await userEvent.keyboard('?');
    expect(
      screen.getByTestId('keyboard-shortcuts-overlay'),
    ).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByTestId('keyboard-shortcuts-overlay'),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when the Close button is clicked', async () => {
    renderAt('/', <KeyboardShortcutsOverlay />);
    await userEvent.keyboard('?');
    await userEvent.click(screen.getByTestId('keyboard-shortcuts-close'));
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
  });

  it('closes when the backdrop is clicked', async () => {
    renderAt('/', <KeyboardShortcutsOverlay />);
    await userEvent.keyboard('?');
    const overlay = screen.getByTestId('keyboard-shortcuts-overlay');
    await userEvent.click(overlay);
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
  });

  it('does not open while focus is in a text input', async () => {
    renderAt('/', <KeyboardShortcutsOverlay />);
    const input = document.createElement('input');
    input.setAttribute('data-test-cleanup', 'true');
    document.body.appendChild(input);
    input.focus();
    await userEvent.keyboard('?');
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
  });

  it('lists the list-page shortcut bindings', async () => {
    renderAt('/', <KeyboardShortcutsOverlay />);
    await userEvent.keyboard('?');
    const overlay = screen.getByTestId('keyboard-shortcuts-overlay');
    expect(overlay).toHaveTextContent(/Next item/);
    expect(overlay).toHaveTextContent(/Open the reader/);
    expect(overlay).toHaveTextContent(/Pin or unpin/);
    expect(overlay).toHaveTextContent(/Hide \(dismiss\)/);
    // No comments/votes in Readmo.
    expect(overlay).not.toHaveTextContent(/comment/i);
  });

  it('shows reader-scoped shortcuts on /item/:id', async () => {
    renderAt('/item/42', <KeyboardShortcutsOverlay />);
    await userEvent.keyboard('?');
    const overlay = screen.getByTestId('keyboard-shortcuts-overlay');
    expect(overlay).toHaveTextContent(/Next section/);
    expect(overlay).toHaveTextContent(/Favorite or unfavorite/);
    expect(overlay).toHaveTextContent(/Mark the item done/);
    // List-only bindings should not appear here.
    expect(overlay).not.toHaveTextContent(/Next item/);
    expect(overlay).not.toHaveTextContent(/row actions menu/);
  });
});
