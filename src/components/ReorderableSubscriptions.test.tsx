import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ReorderableSubscriptions, type SubscriptionEntry } from './ReorderableSubscriptions';
import type { Feed, FeedId } from '../lib/types';

function feed(id: string, title: string): Feed {
  return {
    id,
    url: `https://${id}.example.com/feed`,
    siteUrl: `https://${id}.example.com`,
    title,
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
  };
}

function entry(id: string, title: string, sort: number): SubscriptionEntry {
  return {
    feed: feed(id, title),
    subscription: { feedId: id, folder: null, titleOverride: null, muted: false, sort },
  };
}

function setup() {
  const subs = [
    entry('a', 'Alpha', 0),
    entry('b', 'Beta', 1),
    entry('c', 'Gamma', 2),
  ];
  const onReorder = vi.fn<(ids: FeedId[]) => void>();
  const onMute = vi.fn();
  const onUnsubscribe = vi.fn();
  render(
    <ReorderableSubscriptions
      subs={subs}
      onReorder={onReorder}
      onMute={onMute}
      onUnsubscribe={onUnsubscribe}
    />,
  );
  return { onReorder, onMute, onUnsubscribe };
}

// The persist is debounced (300ms, only-latest-wins), so drive it with fake
// timers and flush after the events that should trigger a write.
const DEBOUNCE_MS = 300;
const flushPersist = () => act(() => vi.advanceTimersByTime(DEBOUNCE_MS));

describe('ReorderableSubscriptions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders a drag handle, Mute, and Unsubscribe per row (three tap zones)', () => {
    setup();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(within(row).getByTestId('sub-drag-handle')).toBeInTheDocument();
      expect(within(row).getByRole('checkbox')).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Unsubscribe' })).toBeInTheDocument();
    }
  });

  it('labels each handle for assistive tech and keyboard use', () => {
    setup();
    expect(
      screen.getByRole('button', { name: /Reorder Alpha \(use the arrow keys\)/ }),
    ).toBeInTheDocument();
  });

  it('moves a feed down with ArrowDown on its handle and persists the new order', () => {
    const { onReorder } = setup();
    const handles = screen.getAllByTestId('sub-drag-handle');
    fireEvent.keyDown(handles[0], { key: 'ArrowDown' });
    flushPersist();
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('moves a feed up with ArrowUp on its handle', () => {
    const { onReorder } = setup();
    const handles = screen.getAllByTestId('sub-drag-handle');
    fireEvent.keyDown(handles[2], { key: 'ArrowUp' });
    flushPersist();
    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('collapses a burst of keyboard moves into a single latest-wins persist', () => {
    const { onReorder } = setup();
    // Move "Alpha" (a) down twice in quick succession; only the final order
    // [b, c, a] should be written, exactly once — no out-of-order intermediate.
    let handle = screen.getAllByTestId('sub-drag-handle')[0];
    fireEvent.keyDown(handle, { key: 'ArrowDown' }); // a,b,c -> b,a,c
    handle = screen.getAllByTestId('sub-drag-handle')[1]; // a re-rendered at idx 1
    fireEvent.keyDown(handle, { key: 'ArrowDown' }); // b,a,c -> b,c,a
    expect(onReorder).not.toHaveBeenCalled(); // still within the debounce window
    flushPersist();
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
  });

  it('does not persist a move past the ends', () => {
    const { onReorder } = setup();
    const handles = screen.getAllByTestId('sub-drag-handle');
    fireEvent.keyDown(handles[0], { key: 'ArrowUp' }); // already first
    flushPersist();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('wires Mute and Unsubscribe to their callbacks', () => {
    const { onMute, onUnsubscribe } = setup();
    const rows = screen.getAllByRole('listitem');
    fireEvent.click(within(rows[1]).getByRole('checkbox'));
    expect(onMute).toHaveBeenCalledWith('b', true);
    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Unsubscribe' }));
    expect(onUnsubscribe).toHaveBeenCalledWith('c');
  });
});
