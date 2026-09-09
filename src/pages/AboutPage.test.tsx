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

  it('sets the document title', () => {
    // Regression: every other routed page sets its title; About kept whatever
    // the previous route left behind (e.g. "Settings · readmo").
    document.title = 'Settings · readmo';
    renderWithProviders(<AboutPage />, { route: '/about' });
    expect(document.title).toBe('About · readmo');
  });

  it('has a back link to Home', () => {
    renderWithProviders(<AboutPage />, { route: '/about' });
    expect(
      screen.getByRole('link', { name: /back to home/i }),
    ).toHaveAttribute('href', '/');
  });

  it('shows the build version/age and links to Debug', () => {
    renderWithProviders(<AboutPage />, { route: '/about' });
    // summarizeBuildAge falls back to this string when build metadata is absent
    // (the case under test/jsdom with no injected build info).
    expect(screen.getByText(/build/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /debug/i })).toHaveAttribute(
      'href',
      '/debug',
    );
  });
});
