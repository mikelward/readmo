import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { LegalPage } from './LegalPage';
import { renderWithProviders } from '../test/renderWithProviders';

describe('<LegalPage>', () => {
  it('renders the Legal heading and an effective date', () => {
    renderWithProviders(<LegalPage />, { route: '/legal' });
    expect(
      screen.getByRole('heading', { level: 1, name: /^legal$/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/last updated:/i)).toBeInTheDocument();
  });

  it('has a copyright/DMCA section with a takedown contact', () => {
    renderWithProviders(<LegalPage />, { route: '/legal' });
    expect(
      screen.getByRole('heading', { level: 2, name: /copyright and dmca/i }),
    ).toBeInTheDocument();
    const contacts = screen.getAllByRole('link', { name: /mikel@mikelward\.com/i });
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts[0]).toHaveAttribute('href', 'mailto:mikel@mikelward.com');
  });

  it('has a counter-notification section with the jurisdiction-consent terms', () => {
    renderWithProviders(<LegalPage />, { route: '/legal' });
    expect(
      screen.getByRole('heading', { level: 2, name: /counter-notification/i }),
    ).toBeInTheDocument();
    // §512(g)(3)(D): consent to federal jurisdiction + acceptance of service.
    expect(screen.getByText(/consent to the jurisdiction/i)).toBeInTheDocument();
    expect(screen.getByText(/accept service of process/i)).toBeInTheDocument();
  });

  it('covers warranty disclaimer and limitation of liability', () => {
    renderWithProviders(<LegalPage />, { route: '/legal' });
    expect(
      screen.getByRole('heading', { level: 2, name: /disclaimer of warranties/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /limitation of liability/i }),
    ).toBeInTheDocument();
  });

  it('credits the operator with a link to mikelward.com', () => {
    renderWithProviders(<LegalPage />, { route: '/legal' });
    const operatorLink = screen.getByRole('link', { name: /mikel ward/i });
    expect(operatorLink).toHaveAttribute('href', 'https://mikelward.com');
    expect(operatorLink).toHaveAttribute('target', '_blank');
    expect(operatorLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('has a back link to Home', () => {
    renderWithProviders(<LegalPage />, { route: '/legal' });
    expect(
      screen.getByRole('link', { name: /back to home/i }),
    ).toHaveAttribute('href', '/');
  });
});
