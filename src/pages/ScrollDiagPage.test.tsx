import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ScrollDiagPage } from './ScrollDiagPage';
import { clearDiag, freezeDiagReport, recordDiag } from '../lib/scrollDiag';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/debug/scroll']}>
      <ScrollDiagPage />
    </MemoryRouter>,
  );
}

describe('ScrollDiagPage', () => {
  beforeEach(() => clearDiag());
  afterEach(() => clearDiag());

  it('invites the reader to record a timeline when empty', () => {
    renderPage();
    expect(screen.getByText('No timeline recorded yet.')).toBeInTheDocument();
  });

  it('summarizes a jump that followed a Done from the frozen report', () => {
    recordDiag({ kind: 'scroll', y: 1200, delta: 20 });
    recordDiag({ kind: 'done', y: 1200, id: 'item-9' });
    recordDiag({ kind: 'scroll', y: 0, delta: -1200 });
    freezeDiagReport();

    renderPage();

    expect(
      screen.getByText(/Jumped -1200px toward the top .*after Done\./),
    ).toBeInTheDocument();
    // Timeline rows for each entry, including the Done marker.
    expect(screen.getByText('Done item-9')).toBeInTheDocument();
  });

  it('flags a big toward-top scroll row as a jump', () => {
    recordDiag({ kind: 'scroll', y: 0, delta: -900 });
    freezeDiagReport();

    const { container } = renderPage();
    expect(container.querySelector('.scroll-diag__row[data-jump]')).toBeTruthy();
  });

  it('falls back to the live buffer when no report is frozen', () => {
    recordDiag({ kind: 'scroll', y: 300, delta: 300 });
    renderPage();
    expect(screen.getByText(/Timeline \(live\)/)).toBeInTheDocument();
  });
});
