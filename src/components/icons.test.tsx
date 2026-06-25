import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { SVGProps } from 'react';
import * as icons from './icons';

const REQUIRED = [
  'PushPinOutline',
  'PushPinFilled',
  'FavoriteOutline',
  'FavoriteFilled',
  'Check',
  'CheckCircleFilled',
  'VisibilityOff',
  'MarkUnread',
  'Search',
  'Menu',
  'ArrowBack',
  'MoreVert',
  'OpenInNew',
  'Share',
  'Refresh',
  'Close',
  'Settings',
  'Folder',
  'Add',
  'Sun',
  'Moon',
  'SystemTheme',
  'ChevronRight',
] as const;

type IconComponent = (props: SVGProps<SVGSVGElement>) => JSX.Element;

describe('icons', () => {
  it('exports every required icon component', () => {
    for (const name of REQUIRED) {
      expect(icons).toHaveProperty(name);
      expect(typeof (icons as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('renders a 24x24 currentColor svg, aria-hidden, for each icon', () => {
    for (const name of REQUIRED) {
      const Icon = (icons as Record<string, IconComponent>)[name];
      const { container, unmount } = render(<Icon data-testid={name} />);
      const svg = container.querySelector('svg');
      expect(svg, name).not.toBeNull();
      expect(svg!.getAttribute('width')).toBe('24');
      expect(svg!.getAttribute('height')).toBe('24');
      expect(svg!.getAttribute('fill')).toBe('currentColor');
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      expect(svg!.querySelector('path')).not.toBeNull();
      unmount();
    }
  });

  it('renders the pin glyphs on the 0 0 24 24 grid with a non-trivial path', () => {
    // Guards against regressing to the malformed Material Symbols push_pin
    // path that rendered as a thin diagonal sliver.
    for (const name of ['PushPinOutline', 'PushPinFilled'] as const) {
      const Icon = (icons as Record<string, IconComponent>)[name];
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('viewBox'), name).toBe('0 0 24 24');
      const d = svg.querySelector('path')!.getAttribute('d') ?? '';
      // The real push_pin shape is a long path; the broken sliver was short.
      expect(d.length, name).toBeGreaterThan(80);
      unmount();
    }
  });

  it('forwards props (className, size override)', () => {
    const { container } = render(
      <icons.Search className="hdr-icon" width={20} height={20} />,
    );
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toBe('hdr-icon');
    expect(svg.getAttribute('width')).toBe('20');
  });
});
