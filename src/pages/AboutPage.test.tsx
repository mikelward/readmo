import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { AboutPage } from './AboutPage';
import { renderWithProviders } from '../test/renderWithProviders';

describe('<AboutPage>', () => {
  it('renders the title and a description of the app', () => {
    renderWithProviders(<AboutPage />, { route: '/about' });
    expect(
      screen.getByRole('heading', { level: 1, name: /about readmo/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/mobile-first reader/i)).toBeInTheDocument();
  });

  it('credits the author with a link to mikelward.com', () => {
    renderWithProviders(<AboutPage />, { route: '/about' });
    const authorLink = screen.getByRole('link', { name: /mikel ward/i });
    expect(authorLink).toHaveAttribute('href', 'https://mikelward.com');
    expect(authorLink).toHaveAttribute('target', '_blank');
    expect(authorLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('has a back link to Home', () => {
    renderWithProviders(<AboutPage />, { route: '/about' });
    expect(
      screen.getByRole('link', { name: /back to home/i }),
    ).toHaveAttribute('href', '/');
  });
});
