import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { ListPage } from './ListPage';

describe('ListPage', () => {
  it('always renders the bottom toolbar with Back to top, even without a header', () => {
    renderWithProviders(
      <ListPage>
        <p>body</p>
      </ListPage>,
    );
    expect(screen.getByTestId('back-to-top')).toBeInTheDocument();
  });

  it('renders the header content when provided', () => {
    renderWithProviders(
      <ListPage header={<h1>My list</h1>}>
        <p>body</p>
      </ListPage>,
    );
    expect(screen.getByRole('heading', { name: 'My list' })).toBeInTheDocument();
  });

  it('omits Undo + Sweep by default and includes them when actions is set', () => {
    const { rerender } = renderWithProviders(
      <ListPage>
        <p>body</p>
      </ListPage>,
    );
    expect(screen.queryByTestId('undo-btn-bottom')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sweep-btn-bottom')).not.toBeInTheDocument();

    rerender(
      <ListPage actions>
        <p>body</p>
      </ListPage>,
    );
    expect(screen.getByTestId('undo-btn-bottom')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-btn-bottom')).toBeInTheDocument();
  });
});
