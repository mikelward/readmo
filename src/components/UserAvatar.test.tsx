import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UserAvatar } from './UserAvatar';

describe('UserAvatar', () => {
  it('renders the initial-on-color disc when there is no picture', () => {
    render(<UserAvatar name="mikel" avatarUrl={null} />);
    const avatar = screen.getByTestId('user-avatar');
    expect(avatar).toHaveTextContent('M');
    expect(screen.queryByTestId('user-avatar-img')).not.toBeInTheDocument();
  });

  it('layers the picture over the initial and fades it in on load', () => {
    render(<UserAvatar name="mikel" avatarUrl="https://example.com/a.png" />);
    const img = screen.getByTestId('user-avatar-img');
    // The initial stays mounted underneath — the image covers it visually.
    expect(screen.getByTestId('user-avatar')).toHaveTextContent('M');
    expect(img).toHaveAttribute('data-loaded', 'false');
    fireEvent.load(img);
    expect(img).toHaveAttribute('data-loaded', 'true');
  });

  it('falls back to the initial when the picture fails to load', () => {
    // A 404ing OAuth picture must not leave a broken-image glyph in the
    // header — the image unmounts and the letter underneath remains.
    render(<UserAvatar name="mikel" avatarUrl="https://example.com/gone.png" />);
    fireEvent.error(screen.getByTestId('user-avatar-img'));
    expect(screen.queryByTestId('user-avatar-img')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-avatar')).toHaveTextContent('M');
  });

  it('retries a NEW picture URL after an earlier one failed', () => {
    // The failure is keyed to the URL, so a refreshed OAuth session with a
    // new picture isn't blocked by the old failure.
    const { rerender } = render(
      <UserAvatar name="mikel" avatarUrl="https://example.com/old.png" />,
    );
    fireEvent.error(screen.getByTestId('user-avatar-img'));
    expect(screen.queryByTestId('user-avatar-img')).not.toBeInTheDocument();
    rerender(<UserAvatar name="mikel" avatarUrl="https://example.com/new.png" />);
    expect(screen.getByTestId('user-avatar-img')).toHaveAttribute(
      'src',
      'https://example.com/new.png',
    );
  });

  it('shows ? for an empty name and stays presentational', () => {
    render(<UserAvatar name="  " avatarUrl={null} />);
    const avatar = screen.getByTestId('user-avatar');
    expect(avatar).toHaveTextContent('?');
    // Decorative: the accessible name lives on the surrounding control.
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
  });
});
