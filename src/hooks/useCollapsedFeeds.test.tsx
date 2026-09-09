import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  COLLAPSED_FEEDS_KEY,
  resetCollapsedFeedsCacheForTest,
  useCollapsedFeeds,
} from './useCollapsedFeeds';

function Probe() {
  const { collapsed, toggle, collapseAll, expand } = useCollapsedFeeds();
  return (
    <div>
      <span data-testid="state">{[...collapsed].sort().join(',') || 'none'}</span>
      <button type="button" onClick={() => toggle('a')}>
        toggle-a
      </button>
      <button type="button" onClick={() => collapseAll(['a', 'b', 'c'])}>
        collapse-all
      </button>
      <button type="button" onClick={() => expand(['a', 'b', 'c'])}>
        expand-all
      </button>
      <button type="button" onClick={() => expand(['a', 'b'])}>
        expand-ab
      </button>
    </div>
  );
}

const state = () => screen.getByTestId('state').textContent;
const click = (label: string) =>
  act(() => {
    screen.getByText(label).click();
  });

describe('useCollapsedFeeds', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetCollapsedFeedsCacheForTest();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetCollapsedFeedsCacheForTest();
  });

  it('defaults to nothing collapsed', () => {
    render(<Probe />);
    expect(state()).toBe('none');
  });

  it('toggles a feed on and off, persisting to localStorage', () => {
    render(<Probe />);
    click('toggle-a');
    expect(state()).toBe('a');
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_FEEDS_KEY)!)).toEqual(['a']);
    click('toggle-a');
    expect(state()).toBe('none');
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_FEEDS_KEY)!)).toEqual([]);
  });

  it('collapses all given feeds and expands them all', () => {
    render(<Probe />);
    click('collapse-all');
    expect(state()).toBe('a,b,c');
    click('expand-all');
    expect(state()).toBe('none');
  });

  it('expand only clears the feeds it is given, leaving the rest collapsed', () => {
    render(<Probe />);
    click('collapse-all'); // a,b,c collapsed
    click('expand-ab'); // expand only a,b
    expect(state()).toBe('c'); // c (e.g. a feed outside the view) stays collapsed
  });

  it('reads an existing persisted set on mount', () => {
    window.localStorage.setItem(COLLAPSED_FEEDS_KEY, JSON.stringify(['x', 'y']));
    render(<Probe />);
    expect(state()).toBe('x,y');
  });

  it('shares state across mounted consumers (external store)', () => {
    render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    const [first] = screen.getAllByText('toggle-a');
    act(() => first.click());
    for (const el of screen.getAllByTestId('state')) {
      expect(el.textContent).toBe('a');
    }
  });

  it('ignores a corrupt stored value', () => {
    window.localStorage.setItem(COLLAPSED_FEEDS_KEY, 'not json');
    render(<Probe />);
    expect(state()).toBe('none');
  });
});
