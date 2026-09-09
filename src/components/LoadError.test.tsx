import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LoadError } from './LoadError';

describe('LoadError', () => {
  it('shows the headline and, behind a disclosure, the detail', () => {
    render(
      <LoadError
        headline="Unexpected response fetching the feed list."
        detail="Could not find the function public.feed_items in the schema cache"
      />,
    );
    expect(
      screen.getByText('Unexpected response fetching the feed list.'),
    ).toBeInTheDocument();
    // The detail is present but tucked inside a collapsed <details>.
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(
      screen.getByText(/Could not find the function public\.feed_items/),
    ).toBeInTheDocument();
  });

  it('omits the disclosure when there is no detail', () => {
    render(<LoadError headline="You’re offline. Reconnect to load items." />);
    expect(screen.queryByText('Details')).toBeNull();
  });

  it('links to /offline (saved articles) only when offlineLink is set', () => {
    const { rerender } = render(
      <MemoryRouter>
        <LoadError headline="You’re offline. Reconnect to load items." offlineLink />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'View saved articles' });
    expect(link).toHaveAttribute('href', '/offline');

    rerender(
      <MemoryRouter>
        <LoadError headline="You’re offline. Reconnect to load items." />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: 'View saved articles' })).toBeNull();
  });

  it('renders a Retry button only when onRetry is provided', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <LoadError headline="Couldn’t load items." onRetry={onRetry} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<LoadError headline="Couldn’t load items." />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
