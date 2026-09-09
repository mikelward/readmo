import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { FeedFavicon } from './FeedFavicon';

describe('FeedFavicon', () => {
  it('renders a decorative img with the base class and intrinsic size', () => {
    const { container } = render(
      <FeedFavicon
        url="https://example.com/favicon.ico"
        className="item-row__favicon"
        testId="fav"
      />,
    );
    const img = container.querySelector<HTMLImageElement>('img.item-row__favicon');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://example.com/favicon.ico');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
    expect(img).toHaveAttribute('width', '16');
    expect(img).toHaveAttribute('height', '16');
    expect(img).toHaveAttribute('data-testid', 'fav');
  });

  it('honors a custom size on both dimensions', () => {
    const { container } = render(
      <FeedFavicon
        url="https://example.com/favicon.ico"
        className="page-header__favicon"
        size={20}
      />,
    );
    const img = container.querySelector<HTMLImageElement>('img')!;
    expect(img).toHaveAttribute('width', '20');
    expect(img).toHaveAttribute('height', '20');
  });

  it('owns the box size inline on the img so caller CSS cannot resize it apart from the placeholder', () => {
    const { container } = render(
      <FeedFavicon
        url="https://example.com/favicon.ico"
        className="item-row__favicon"
        size={20}
      />,
    );
    const img = container.querySelector<HTMLImageElement>('img')!;
    expect(img.style.width).toBe('20px');
    expect(img.style.height).toBe('20px');
  });

  it('sizes the reserved placeholder inline to match the icon even with a placeholder class', () => {
    const { container } = render(
      <FeedFavicon
        url={null}
        className="item-list__group-favicon"
        reserveSpace
        placeholderClassName="item-list__group-favicon-placeholder"
        size={20}
      />,
    );
    const span = container.querySelector<HTMLSpanElement>(
      'span.item-list__group-favicon-placeholder',
    )!;
    expect(span).not.toBeNull();
    expect(span.style.width).toBe('20px');
    expect(span.style.height).toBe('20px');
  });

  it('adds the dark-invert class only for dark-monochrome favicons', () => {
    const { container: plain } = render(
      <FeedFavicon
        url="https://www.theverge.com/favicon.ico"
        className="item-row__favicon"
      />,
    );
    expect(
      plain.querySelector('.item-row__favicon'),
    ).not.toHaveClass('favicon--invert-dark');

    const { container: mono } = render(
      <FeedFavicon
        url="https://www.vox.com/favicon.ico"
        className="item-row__favicon"
      />,
    );
    expect(mono.querySelector('.item-row__favicon')).toHaveClass(
      'favicon--invert-dark',
    );
  });

  it('collapses to nothing when there is no URL and space is not reserved', () => {
    const { container } = render(
      <FeedFavicon url={null} className="item-row__favicon" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('span')).toBeNull();
  });

  it('renders a reserved placeholder box when there is no URL and space is reserved', () => {
    const { container } = render(
      <FeedFavicon
        url={null}
        className="item-list__group-favicon"
        reserveSpace
        placeholderClassName="item-list__group-favicon-placeholder"
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    const placeholder = container.querySelector(
      '.item-list__group-favicon-placeholder',
    );
    expect(placeholder).not.toBeNull();
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
  });

  it('falls back to an inline-sized placeholder when no placeholder class is given', () => {
    const { container } = render(
      <FeedFavicon url={undefined} className="x" reserveSpace size={20} />,
    );
    const span = container.querySelector<HTMLSpanElement>('span');
    expect(span).not.toBeNull();
    expect(span!.style.width).toBe('20px');
    expect(span!.style.height).toBe('20px');
  });

  it('draws an initials badge (not a broken img) when the favicon fails to load', () => {
    const { container } = render(
      <FeedFavicon
        url="https://www.ft.com/favicon.ico"
        name="Financial Times"
        className="item-row__favicon"
        size={20}
      />,
    );
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    const badge = container.querySelector<HTMLSpanElement>('span.favicon--initials')!;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('FT');
    // Fills the same box, with a color background and the surface class kept.
    expect(badge.style.width).toBe('20px');
    expect(badge.style.height).toBe('20px');
    expect(badge.style.background).not.toBe('');
    expect(badge).toHaveClass('item-row__favicon');
  });

  it('draws the initials badge immediately when there is no favicon URL but a name', () => {
    const { container } = render(
      <FeedFavicon url={null} name="The Economist" className="x" />,
    );
    expect(container.querySelector('img')).toBeNull();
    const badge = container.querySelector<HTMLSpanElement>('span.favicon--initials')!;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('E'); // leading "The" dropped
  });

  it('keeps the blank placeholder (no badge) when there is no name to draw', () => {
    const { container } = render(
      <FeedFavicon
        url="https://example.com/favicon.ico"
        className="item-list__group-favicon"
        reserveSpace
        placeholderClassName="item-list__group-favicon-placeholder"
        size={20}
      />,
    );
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.favicon--initials')).toBeNull();
    const placeholder = container.querySelector<HTMLSpanElement>(
      'span.item-list__group-favicon-placeholder',
    )!;
    expect(placeholder).not.toBeNull();
    expect(placeholder.style.width).toBe('20px');
  });

  it('does not apply the dark-invert class to the initials badge', () => {
    // vox.com is a dark-monochrome domain (its real icon inverts); the badge is
    // a colored letter mark and must never be inverted.
    const { container } = render(
      <FeedFavicon
        url="https://www.vox.com/favicon.ico"
        name="Vox"
        className="item-row__favicon"
      />,
    );
    expect(container.querySelector('.item-row__favicon')).toHaveClass(
      'favicon--invert-dark',
    );
    fireEvent.error(container.querySelector('img')!);
    const badge = container.querySelector('.favicon--initials')!;
    expect(badge).not.toHaveClass('favicon--invert-dark');
  });
});
