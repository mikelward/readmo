import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ReorderableSubscriptions, type SubscriptionEntry } from './ReorderableSubscriptions';
import type { Feed, FeedId } from '../lib/types';

function feed(id: string, title: string, host = `${id}.example.com`): Feed {
  return {
    id,
    url: `https://${host}/feed`,
    siteUrl: `https://${host}`,
    title,
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
  };
}

function entry(
  id: string,
  title: string,
  sort: number,
  openOriginal = false,
): SubscriptionEntry {
  return {
    feed: feed(id, title),
    subscription: {
      feedId: id,
      folder: null,
      titleOverride: null,
      muted: false,
      openOriginal,
      openNewshacker: false,
      sort,
    },
  };
}

/** A Hacker News feed entry (its open-mode control is the three-way radio). */
function hnEntry(
  id: string,
  title: string,
  sort: number,
  overrides: Partial<SubscriptionEntry['subscription']> = {},
): SubscriptionEntry {
  return {
    feed: feed(id, title, 'news.ycombinator.com'),
    subscription: {
      feedId: id,
      folder: null,
      titleOverride: null,
      muted: false,
      openOriginal: false,
      openNewshacker: false,
      sort,
      ...overrides,
    },
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
  const onSetOpenOriginal = vi.fn();
  const onSetOpenMode = vi.fn();
  const onUnsubscribe = vi.fn();
  const onRename = vi.fn<(id: FeedId, title: string | null) => void>();
  render(
    <ReorderableSubscriptions
      subs={subs}
      onReorder={onReorder}
      onMute={onMute}
      onSetOpenOriginal={onSetOpenOriginal}
      onSetOpenMode={onSetOpenMode}
      onUnsubscribe={onUnsubscribe}
      onRename={onRename}
    />,
  );
  return { onReorder, onMute, onSetOpenOriginal, onSetOpenMode, onUnsubscribe, onRename };
}

// The persist is debounced (300ms, only-latest-wins), so drive it with fake
// timers and flush after the events that should trigger a write.
const DEBOUNCE_MS = 300;
const flushPersist = () => act(() => vi.advanceTimersByTime(DEBOUNCE_MS));

describe('ReorderableSubscriptions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders three tap zones per row: drag handle, row body, overflow menu', () => {
    setup();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(within(row).getByTestId('sub-drag-handle')).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: /^Actions for / })).toBeInTheDocument();
      // No inline Mute or Unsubscribe; they live behind the overflow.
      expect(within(row).queryByRole('checkbox')).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Unsubscribe' })).toBeNull();
      expect(within(row).queryByRole('menu')).toBeNull();
    }
  });

  it('opens the overflow menu with Rename / Mute / Open original / Unsubscribe and toggles closed', () => {
    setup();
    const overflow = screen.getByRole('button', { name: 'Actions for Alpha' });
    expect(overflow).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(overflow);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Mute' })).toBeInTheDocument();
    const openOriginal = within(menu).getByRole('menuitemcheckbox', {
      name: 'Open original',
    });
    expect(openOriginal).toBeInTheDocument();
    expect(openOriginal).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getByRole('menuitem', { name: 'Unsubscribe' })).toBeInTheDocument();
    expect(overflow).toHaveAttribute('aria-expanded', 'true');
    // Click again to close.
    fireEvent.click(overflow);
    expect(screen.queryByRole('menu')).toBeNull();
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

  it('serializes in-flight persists so a slow earlier write cannot beat a later one', async () => {
    // onReorder returns a promise we resolve manually, simulating a slow RPC.
    const resolvers: Array<() => void> = [];
    const onReorder = vi.fn(
      (_ids: FeedId[]) => new Promise<void>((res) => resolvers.push(res)),
    );
    render(
      <ReorderableSubscriptions
        subs={[entry('a', 'Alpha', 0), entry('b', 'Beta', 1), entry('c', 'Gamma', 2)]}
        onReorder={onReorder}
        onMute={vi.fn()}
        onSetOpenOriginal={vi.fn()}
        onSetOpenMode={vi.fn()}
        onUnsubscribe={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    const handles = () => screen.getAllByTestId('sub-drag-handle');

    // Move 1: a down → [b,a,c]; flush debounce → first RPC starts (stays pending).
    fireEvent.keyDown(handles()[0], { key: 'ArrowDown' });
    flushPersist();
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenLastCalledWith(['b', 'a', 'c']);

    // Move 2 while RPC1 is still in flight: a (now index 1) down → [b,c,a].
    fireEvent.keyDown(handles()[1], { key: 'ArrowDown' });
    flushPersist();
    // Queued behind the in-flight write, not fired as a second concurrent RPC.
    expect(onReorder).toHaveBeenCalledTimes(1);

    // Resolve RPC1 → the queued final order is sent next, after it (in order).
    await act(async () => {
      resolvers[0]();
    });
    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(onReorder).toHaveBeenLastCalledWith(['b', 'c', 'a']);
  });

  it('does not persist a move past the ends', () => {
    const { onReorder } = setup();
    const handles = screen.getAllByTestId('sub-drag-handle');
    fireEvent.keyDown(handles[0], { key: 'ArrowUp' }); // already first
    flushPersist();
    expect(onReorder).not.toHaveBeenCalled();
  });

  // Helper: open the overflow menu for the row with the given title.
  function openMenu(title: string) {
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${title}` }));
  }

  it('wires Mute and Unsubscribe to their callbacks via the overflow menu', () => {
    const { onMute, onUnsubscribe } = setup();
    openMenu('Beta');
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Mute' }),
    );
    expect(onMute).toHaveBeenCalledWith('b', true);
    expect(screen.queryByRole('menu')).toBeNull(); // closes after action
    openMenu('Gamma');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unsubscribe' }));
    expect(onUnsubscribe).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('toggles "Open original" on via the overflow menu', () => {
    const { onSetOpenOriginal } = setup();
    openMenu('Beta');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Open original' }));
    expect(onSetOpenOriginal).toHaveBeenCalledWith('b', true);
    expect(screen.queryByRole('menu')).toBeNull(); // closes after action
  });

  it('marks "Open original" checked and toggles it back off when already set', () => {
    const onSetOpenOriginal = vi.fn();
    render(
      <ReorderableSubscriptions
        subs={[entry('a', 'Alpha', 0, /* openOriginal */ true)]}
        onReorder={vi.fn()}
        onMute={vi.fn()}
        onSetOpenOriginal={onSetOpenOriginal}
        onSetOpenMode={vi.fn()}
        onUnsubscribe={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    openMenu('Alpha');
    const item = screen.getByRole('menuitemcheckbox', { name: 'Open original' });
    expect(item).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(item);
    expect(onSetOpenOriginal).toHaveBeenCalledWith('a', false);
  });

  it('hides the "Open original" item when the backend does not support it', () => {
    render(
      <ReorderableSubscriptions
        subs={[entry('a', 'Alpha', 0)]}
        onReorder={vi.fn()}
        onMute={vi.fn()}
        onSetOpenOriginal={vi.fn()}
        onSetOpenMode={vi.fn()}
        showOpenOriginal={false}
        onUnsubscribe={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    openMenu('Alpha');
    const menu = screen.getByRole('menu');
    expect(
      within(menu).queryByRole('menuitemcheckbox', { name: 'Open original' }),
    ).toBeNull();
    // The rest of the menu is unaffected.
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Unsubscribe' })).toBeInTheDocument();
  });

  // --- Hacker News feeds: the three-way open-mode choice -------------------

  function renderHn(
    sub: Partial<SubscriptionEntry['subscription']> = {},
    props: { showOpenOriginal?: boolean; showOpenNewshacker?: boolean } = {},
  ) {
    const onSetOpenMode = vi.fn();
    const onSetOpenOriginal = vi.fn();
    render(
      <ReorderableSubscriptions
        subs={[hnEntry('hn', 'Hacker News', 0, sub)]}
        onReorder={vi.fn()}
        onMute={vi.fn()}
        onSetOpenOriginal={onSetOpenOriginal}
        onSetOpenMode={onSetOpenMode}
        onUnsubscribe={vi.fn()}
        onRename={vi.fn()}
        {...props}
      />,
    );
    return { onSetOpenMode, onSetOpenOriginal };
  }

  it('offers a three-way open-mode radio for a Hacker News feed (reader default)', () => {
    renderHn();
    openMenu('Hacker News');
    const menu = screen.getByRole('menu');
    // No two-state checkbox — the choice is mutually exclusive radios instead.
    expect(
      within(menu).queryByRole('menuitemcheckbox', { name: 'Open original' }),
    ).toBeNull();
    const reader = within(menu).getByRole('menuitemradio', { name: 'In-app reader' });
    const original = within(menu).getByRole('menuitemradio', { name: 'Open original' });
    const newshacker = within(menu).getByRole('menuitemradio', {
      name: 'Open on newshacker',
    });
    expect(reader).toHaveAttribute('aria-checked', 'true');
    expect(original).toHaveAttribute('aria-checked', 'false');
    expect(newshacker).toHaveAttribute('aria-checked', 'false');
  });

  it('selecting "Open on newshacker" sets the newshacker open mode', () => {
    const { onSetOpenMode } = renderHn();
    openMenu('Hacker News');
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'Open on newshacker' }),
    );
    expect(onSetOpenMode).toHaveBeenCalledWith('hn', 'newshacker');
    expect(screen.queryByRole('menu')).toBeNull(); // closes after the choice
  });

  it('marks the newshacker radio checked when the feed is already in that mode', () => {
    const { onSetOpenMode } = renderHn({ openNewshacker: true });
    openMenu('Hacker News');
    expect(
      screen.getByRole('menuitemradio', { name: 'Open on newshacker' }),
    ).toHaveAttribute('aria-checked', 'true');
    // Re-picking the current mode is a no-op (no redundant write).
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'Open on newshacker' }),
    );
    expect(onSetOpenMode).not.toHaveBeenCalled();
  });

  it('switching a newshacker feed back to the reader sets the reader mode', () => {
    const { onSetOpenMode } = renderHn({ openNewshacker: true });
    openMenu('Hacker News');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'In-app reader' }));
    expect(onSetOpenMode).toHaveBeenCalledWith('hn', 'reader');
  });

  it('falls back to the Open-original checkbox for a Hacker News feed when newshacker is unsupported', () => {
    renderHn({}, { showOpenNewshacker: false });
    openMenu('Hacker News');
    const menu = screen.getByRole('menu');
    expect(
      within(menu).queryByRole('menuitemradio', { name: 'Open on newshacker' }),
    ).toBeNull();
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'Open original' }),
    ).toBeInTheDocument();
  });

  it('does not offer "Open on newshacker" for a non–Hacker News feed', () => {
    setup();
    openMenu('Alpha');
    const menu = screen.getByRole('menu');
    expect(
      within(menu).queryByRole('menuitemradio', { name: 'Open on newshacker' }),
    ).toBeNull();
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'Open original' }),
    ).toBeInTheDocument();
  });

  it('shows Unmute when the feed is already muted', () => {
    const subs = [
      { ...entry('a', 'Alpha', 0), subscription: { ...entry('a', 'Alpha', 0).subscription, muted: true } },
    ];
    render(
      <ReorderableSubscriptions
        subs={subs}
        onReorder={vi.fn()}
        onMute={vi.fn()}
        onSetOpenOriginal={vi.fn()}
        onSetOpenMode={vi.fn()}
        onUnsubscribe={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    openMenu('Alpha');
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Unmute' }),
    ).toBeInTheDocument();
  });

  it('renames a feed via overflow → Rename → type → Enter', () => {
    const { onRename } = setup();
    openMenu('Alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(screen.queryByRole('menu')).toBeNull(); // menu closes when edit opens
    const input = screen.getByRole('textbox', { name: 'Rename Alpha' });
    fireEvent.change(input, { target: { value: 'Alpha (custom)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('a', 'Alpha (custom)');
  });

  it('clears the title override when the rename input is emptied', () => {
    const { onRename } = setup();
    openMenu('Beta');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename Beta' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('b', null);
  });

  it('does not persist a rename when the title is unchanged', () => {
    const { onRename } = setup();
    openMenu('Gamma');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename Gamma' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('cancels the rename on Escape without persisting', () => {
    const { onRename } = setup();
    openMenu('Alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename Alpha' });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    // Input is gone, title display is back.
    expect(screen.queryByRole('textbox', { name: /^Rename / })).toBeNull();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('commits a rename on blur', () => {
    const { onRename } = setup();
    openMenu('Alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename Alpha' });
    fireEvent.change(input, { target: { value: 'Alpha 2' } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith('a', 'Alpha 2');
  });

  it('does not drop a subsequent blur-commit after an Enter-commit', () => {
    // Regression: the commit-suppression flag must be cleared on a new edit,
    // not relied on a synthetic blur React may not deliver when the input
    // unmounts. Two consecutive renames where the first ends via Enter and the
    // second via blur must both call onRename.
    const { onRename } = setup();
    openMenu('Alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Rename Alpha' }),
      { target: { value: 'Alpha v2' } },
    );
    fireEvent.keyDown(
      screen.getByRole('textbox', { name: 'Rename Alpha' }),
      { key: 'Enter' },
    );
    expect(onRename).toHaveBeenNthCalledWith(1, 'a', 'Alpha v2');
    // Now rename a different row, ending via blur.
    openMenu('Beta');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input2 = screen.getByRole('textbox', { name: 'Rename Beta' });
    fireEvent.change(input2, { target: { value: 'Beta v2' } });
    fireEvent.blur(input2);
    expect(onRename).toHaveBeenNthCalledWith(2, 'b', 'Beta v2');
  });

  it('closes the overflow menu on Escape', () => {
    setup();
    openMenu('Alpha');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('serializes rename writes per feed so the last edit wins', async () => {
    // Race: the input closes synchronously on commit, so the user can reopen
    // the menu and rename again before the first write has resolved. If both
    // writes are in flight concurrently, the older one can land after the
    // newer one and the saved title ends up stale. Two reopens land in the
    // queue (latest wins) and only fire after the in-flight write resolves.
    const resolvers: Array<() => void> = [];
    const onRename = vi.fn(
      (_id: FeedId, _title: string | null) =>
        new Promise<void>((res) => resolvers.push(res)),
    );
    render(
      <ReorderableSubscriptions
        subs={[entry('a', 'Alpha', 0)]}
        onReorder={vi.fn()}
        onMute={vi.fn()}
        onSetOpenOriginal={vi.fn()}
        onSetOpenMode={vi.fn()}
        onUnsubscribe={vi.fn()}
        onRename={onRename}
      />,
    );
    function commitTo(value: string) {
      fireEvent.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      const input = screen.getByRole('textbox', { name: 'Rename Alpha' });
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }

    commitTo('First');
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenLastCalledWith('a', 'First');

    // Two more commits while First is still in flight. Both queue; the latest
    // wins. No second concurrent RPC fires yet.
    commitTo('Second');
    commitTo('Third');
    expect(onRename).toHaveBeenCalledTimes(1);

    // First resolves → the queued latest ('Third') fires next, not 'Second'.
    await act(async () => {
      resolvers[0]();
    });
    expect(onRename).toHaveBeenCalledTimes(2);
    expect(onRename).toHaveBeenLastCalledWith('a', 'Third');

    // Drain the second write so no dangling promise outlives the test.
    await act(async () => {
      resolvers[1]();
    });
  });

  it('enqueues a same-displayed-title commit while a rename is in flight (undo)', async () => {
    // Regression for the "undo a pending rename" path: while the first write
    // is in flight, the row keeps rendering the pre-edit title. If the user
    // reopens the editor and re-commits that displayed value (intending to
    // undo their pending edit), the no-op short-circuit must NOT fire — the
    // pending write would otherwise land and overwrite the user's last
    // intention.
    const resolvers: Array<() => void> = [];
    const onRename = vi.fn(
      (_id: FeedId, _title: string | null) =>
        new Promise<void>((res) => resolvers.push(res)),
    );
    render(
      <ReorderableSubscriptions
        subs={[entry('a', 'Alpha', 0)]}
        onReorder={vi.fn()}
        onMute={vi.fn()}
        onSetOpenOriginal={vi.fn()}
        onSetOpenMode={vi.fn()}
        onUnsubscribe={vi.fn()}
        onRename={onRename}
      />,
    );
    function commitTo(value: string) {
      fireEvent.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      const input = screen.getByRole('textbox', { name: 'Rename Alpha' });
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }

    // First commit: rename to Beta. Write stays in flight.
    commitTo('Beta');
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenLastCalledWith('a', 'Beta');

    // While the row still renders "Alpha", the user reopens and re-commits the
    // displayed value — the intent is to undo the pending rename, not no-op.
    commitTo('Alpha');

    // Resolving the first write must fan out the queued 'Alpha' value next.
    await act(async () => {
      resolvers[0]();
    });
    expect(onRename).toHaveBeenCalledTimes(2);
    expect(onRename).toHaveBeenLastCalledWith('a', 'Alpha');

    await act(async () => {
      resolvers[1]();
    });
  });
});
