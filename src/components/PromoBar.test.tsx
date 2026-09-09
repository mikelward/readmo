import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromoBar } from './PromoBar';

// Each test uses a unique promo id so the module-level snapshot cache in
// usePromoDismissed can't leak a dismissal state between cases.
let seq = 0;
function freshId() {
  return `test-promo-${seq++}`;
}

describe('PromoBar', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('renders its copy and a dismiss button', () => {
    render(<PromoBar id={freshId()}>Pin an article to download it</PromoBar>);
    expect(screen.getByText('Pin an article to download it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('hides and persists the dismissal when the close button is tapped', async () => {
    const user = userEvent.setup();
    const id = freshId();
    render(<PromoBar id={id}>Pin an article to download it</PromoBar>);

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(
      screen.queryByText('Pin an article to download it'),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem(`readmo:promo-dismissed:${id}`)).toBe('1');
  });

  it('renders nothing when already dismissed on this device', () => {
    const id = freshId();
    window.localStorage.setItem(`readmo:promo-dismissed:${id}`, '1');
    const { container } = render(<PromoBar id={id}>Pin an article to download it</PromoBar>);
    expect(container).toBeEmptyDOMElement();
  });

  it('dismissing one bar hides every mounted bar with the same id', async () => {
    const user = userEvent.setup();
    const id = freshId();
    render(
      <>
        <PromoBar id={id}>First copy</PromoBar>
        <PromoBar id={id}>First copy</PromoBar>
      </>,
    );
    expect(screen.getAllByText('First copy')).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: /dismiss/i })[0]);

    expect(screen.queryByText('First copy')).not.toBeInTheDocument();
  });
});
