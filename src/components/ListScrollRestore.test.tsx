import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { ListScrollRestore } from './ListScrollRestore';
import { clearListScrollAnchors } from '../lib/listScrollAnchor';

const CHROME_HEIGHT = 100;
const ROW_HEIGHT = 60;

// The modeled window scroll. Reads through `window.scrollY`; `window.scrollTo`
// moves it, exactly as the restore expects.
let scrollY = 0;

/** Lay the rendered rows out under a sticky chrome: row `i` sits at document
 * offset CHROME_HEIGHT + i * ROW_HEIGHT, and its viewport rect follows the
 * modeled scroll. Read live (not snapshotted) so scrolling without a re-render
 * moves the rows, like a real browser. */
/** A row's height: one row normally, two when `data-tall` is set — the test's
 * stand-in for a headline that wraps to a second line. */
function heightOf(li: HTMLElement): number {
  return li.hasAttribute('data-tall') ? 2 * ROW_HEIGHT : ROW_HEIGHT;
}

function stubRowRects(list: HTMLElement): void {
  for (const child of Array.from(list.children)) {
    const li = child as HTMLElement;
    li.getBoundingClientRect = () => {
      // Read live and cumulatively, so a row above this one changing height
      // moves it — as a re-wrapped headline or a late image would.
      let top = CHROME_HEIGHT - scrollY;
      for (const sibling of Array.from(list.children)) {
        if (sibling === li) break;
        top += heightOf(sibling as HTMLElement);
      }
      const height = heightOf(li);
      return {
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
  }
}

function List({ ids, tall = [] }: { ids: string[]; tall?: string[] }) {
  const ref = useRef<HTMLUListElement>(null);
  // Re-stub after every render so rows added by a later render are laid out too.
  useLayoutEffect(() => {
    if (ref.current) stubRowRects(ref.current);
  });
  return (
    <ul ref={ref}>
      {ids.map((id) => (
        <li key={id} data-item-id={id} data-tall={tall.includes(id) ? '' : undefined}>
          {tall.includes(id) ? `${id} (edited headline that wraps)` : id}
        </li>
      ))}
    </ul>
  );
}

// Router navigation, reachable from the test body. Published from an effect
// rather than during render, so the capture isn't a render-time side effect.
const nav: { go: ReturnType<typeof useNavigate> | null } = { go: null };
function navigate(to: string | number): void {
  nav.go?.(to as string);
}
function CaptureNavigate() {
  const go = useNavigate();
  useEffect(() => {
    nav.go = go;
  }, [go]);
  return null;
}

function Harness({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/']}>
      <div className="app-header" />
      <ListScrollRestore />
      <CaptureNavigate />
      {children}
    </MemoryRouter>
  );
}

/** Queued animation frames, flushed on demand so the retry loop is deterministic
 * (no waiting, no timing races). */
let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
function flushFrames(): void {
  // Drain in waves — a frame re-schedules the next one — bounded so a runaway
  // loop fails the test rather than hanging it.
  act(() => {
    for (let guard = 0; guard < 50 && frames.size > 0; guard += 1) {
      const wave = frames;
      frames = new Map();
      for (const cb of wave.values()) cb(0);
    }
  });
}

describe('<ListScrollRestore>', () => {
  beforeEach(() => {
    scrollY = 0;
    frames = new Map();
    nextFrameId = 1;
    clearListScrollAnchors();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    });
    // A real cancel, so a test can't pass only because an aborted frame ran
    // anyway (and can't fail because one did).
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => scrollY,
    });
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      writable: true,
      value: (_x: number, y: number) => {
        scrollY = y;
      },
    });
    // The sticky chrome the anchor offsets are measured from.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('app-header') ? CHROME_HEIGHT : 0;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearListScrollAnchors();
  });

  /** Scroll the modeled window and let the capture run. */
  function scrollTo(y: number): void {
    scrollY = y;
    fireEvent.scroll(window);
    flushFrames();
  }

  it('holds the reader in front of the same article when rows above are dropped on Back', () => {
    // The reported bug: auto-hide's strike-in-place hold lives in the list
    // component, so every row scrolled past is dropped when the list remounts on
    // Back. Here rows a-c go while the reader is in the reader view.
    const { rerender } = render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    // Scrolled three rows down, so `d` leads the list under the chrome.
    scrollTo(3 * ROW_HEIGHT);

    act(() => {
      navigate('/item/d');
    });
    // Back to a list three rows shorter, with the browser handing back the same
    // pixel offset it saved — which is what lands the reader on `g` territory.
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['d', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate(-1);
    });
    expect(scrollY).toBe(3 * ROW_HEIGHT); // un-corrected: `d` is off the top
    flushFrames();
    // Corrected: `d` is back under the chrome, where the reader left it.
    expect(scrollY).toBe(0);
  });

  it('restores against a following row when the article you opened is gone', () => {
    const { rerender } = render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    scrollTo(3 * ROW_HEIGHT); // `d` leads
    act(() => {
      navigate('/item/d');
    });
    // A mark-done-on-open feed drops `d` — the anchor row itself — on the way
    // back, leaving the rows above it in place.
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate(-1);
    });
    flushFrames();
    // `e` was recorded a row below `d`, so it's put back a row below the
    // chrome — not yanked up into `d`'s slot, which would shift everything the
    // reader hadn't read yet.
    const row = document.querySelector('li[data-item-id="e"]')!;
    expect(row.getBoundingClientRect().top).toBe(CHROME_HEIGHT + ROW_HEIGHT);
  });

  it('settles at the top when the list is too short to seat the anchor', () => {
    const { rerender } = render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    scrollTo(2 * ROW_HEIGHT); // `c` leads, `d` a row below it
    act(() => {
      navigate('/item/c');
    });
    // Everything above `d` is gone, so the row can't sit a row below the chrome
    // any more — there's nothing left to scroll past. The top of the list is as
    // close as it gets, and the retry must recognize that instead of
    // re-requesting an unreachable offset every frame.
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['d', 'e']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate(-1);
    });
    flushFrames();
    expect(scrollY).toBe(0);
    expect(frames.size).toBe(0); // gave up rather than burning the budget
  });

  it('waits for a list that has not painted yet, then restores', () => {
    const { rerender } = render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    scrollTo(2 * ROW_HEIGHT);
    act(() => {
      navigate('/item/c');
    });
    // Cold return: the cache is still hydrating, so Back paints an empty list.
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={[]} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate(-1);
    });
    flushFrames();
    expect(scrollY).toBe(2 * ROW_HEIGHT); // nothing to aim at yet
    // Rows arrive a beat later, still within the retry budget.
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['c', 'd']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    flushFrames();
    expect(scrollY).toBe(0);
  });

  it('keeps holding when the list re-materializes after the first correction settled', async () => {
    // Opening an article refetches a stale feed on purpose, so the reflow lands
    // while the feed is off screen — but a quick Back (or a slow response) puts
    // it *after* the return. Settling once and walking away would let that
    // reflow displace the reader exactly as before.
    const { rerender } = render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    scrollTo(3 * ROW_HEIGHT); // `d` leads
    act(() => {
      navigate('/item/d');
    });
    // Back paints the cached list, unchanged — nothing to correct, so the first
    // pass settles immediately.
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate(-1);
    });
    flushFrames();
    expect(scrollY).toBe(3 * ROW_HEIGHT);

    // The in-flight refetch lands a beat later, consolidating the dismissed rows
    // above the reader out of the set.
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['d', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    // The observer reports the changed rows on a microtask.
    await act(async () => {});
    flushFrames();
    expect(scrollY).toBe(0); // `d` is back under the chrome
  });

  it('holds when a row above is rewritten in place and re-wraps taller', async () => {
    // A stale refetch can return the same ids with edited titles — the poller
    // updates them in place — so React rewrites a row's text without adding or
    // removing anything. A headline that wraps to a second line pushes
    // everything below it down just as surely as a new row would.
    const { rerender } = render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    scrollTo(2 * ROW_HEIGHT); // `c` leads
    act(() => {
      navigate('/item/c');
    });
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate(-1);
    });
    flushFrames();
    expect(scrollY).toBe(2 * ROW_HEIGHT); // in place already

    // `b`'s headline is edited and now takes two lines.
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e']} tall={['b']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    await act(async () => {});
    flushFrames();
    // `c` is a row lower in the document now, so the hold scrolls a row further
    // to keep it under the chrome.
    expect(scrollY).toBe(3 * ROW_HEIGHT);
    expect(
      document.querySelector('li[data-item-id="c"]')!.getBoundingClientRect().top,
    ).toBe(CHROME_HEIGHT);
  });

  it('holds when heights change with no DOM change at all', () => {
    // A favicon finishing, a webfont swapping in: nothing mutates, the rows just
    // get taller. Only the resize observer sees those.
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    const { rerender } = render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    scrollTo(2 * ROW_HEIGHT);
    act(() => {
      navigate('/item/c');
    });
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate(-1);
    });
    flushFrames();
    expect(scrollY).toBe(2 * ROW_HEIGHT);

    // Grow a row above the reader without touching the DOM tree or its text.
    document.querySelector('li[data-item-id="a"]')!.setAttribute('data-tall', '');
    act(() => {
      for (const fire of observers) fire();
    });
    flushFrames();
    expect(scrollY).toBe(3 * ROW_HEIGHT);
  });

  it('stops holding once the reader takes over, even if the list changes later', async () => {
    const { rerender } = render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    scrollTo(3 * ROW_HEIGHT);
    act(() => {
      navigate('/item/d');
    });
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate(-1);
    });
    flushFrames();
    // The reader scrolls on: the hold is theirs to end, and a later reflow must
    // not yank them back to where they came in.
    fireEvent.wheel(window);
    scrollTo(5 * ROW_HEIGHT);
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['d', 'e', 'f']} />} />
          <Route path="/item/d" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    await act(async () => {});
    flushFrames();
    expect(scrollY).toBe(5 * ROW_HEIGHT);
  });

  it('re-records the anchor after a correction, so a second Back still has rows to aim at', () => {
    // The reader never has to scroll again for an entry to be revisited: read an
    // article, Back, read the next, Back. Nothing there fires the scroll capture,
    // so without re-recording after each correction the entry keeps its original
    // rows until every one of them has been read and dropped — and the Back after
    // that has nothing to aim at, falling back to the raw pixel offset.
    let ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    const view = () => (
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={ids} />} />
          <Route path="/item/x" element={<div>reader</div>} />
        </Routes>
      </Harness>
    );
    const { rerender } = render(view());
    scrollTo(3 * ROW_HEIGHT); // `d` leads; the anchor records d, e, f, g, h

    // First article: `d` is read and dropped on the way back. The correction
    // holds the rest in place — and re-records, now led by `c`.
    act(() => {
      navigate('/item/x');
    });
    ids = ids.filter((id) => id !== 'd');
    rerender(view());
    act(() => {
      navigate(-1);
    });
    flushFrames();
    expect(
      document.querySelector('li[data-item-id="c"]')!.getBoundingClientRect().top,
    ).toBe(CHROME_HEIGHT);

    // Second article, and this time the return also compacts away the run the
    // reader had already finished — `a` and `b` above them, and `e` through `h`
    // below. Every row the ORIGINAL anchor recorded is now gone.
    act(() => {
      navigate('/item/x');
    });
    ids = ids.filter((id) => !['a', 'b', 'e', 'f', 'g', 'h'].includes(id));
    rerender(view());
    act(() => {
      navigate(-1);
    });
    flushFrames();
    // `c` — recorded by the refreshed anchor — is still under the chrome. On the
    // original anchor alone there'd be nothing rendered to measure, and the
    // reader would be left two rows down against the compacted list.
    expect(
      document.querySelector('li[data-item-id="c"]')!.getBoundingClientRect().top,
    ).toBe(CHROME_HEIGHT);
  });

  it('leaves forward navigation alone', () => {
    render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c']} />} />
          <Route path="/other" element={<List ids={['x', 'y', 'z']} />} />
        </Routes>
      </Harness>,
    );
    scrollTo(ROW_HEIGHT);
    act(() => {
      navigate('/other');
    });
    flushFrames();
    // A PUSH belongs to <ScrollToTop>; this must not drag the new view back to
    // the previous one's anchor.
    expect(scrollY).toBe(ROW_HEIGHT);
  });

  it('stops correcting the moment the reader touches the screen', () => {
    const { rerender } = render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c', 'd']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    scrollTo(2 * ROW_HEIGHT);
    act(() => {
      navigate('/item/c');
    });
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={[]} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate(-1);
    });
    // The reader starts scrolling before the list has painted — they're driving
    // now, so the pending correction is abandoned rather than yanking them back.
    fireEvent.touchStart(window);
    rerender(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['c', 'd']} />} />
          <Route path="/item/c" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    flushFrames();
    expect(scrollY).toBe(2 * ROW_HEIGHT);
  });

  it('re-records when the list re-materializes under a reader who has not scrolled', async () => {
    // A focus/reconnect refetch, a pull-to-refresh, a cross-device dismiss: the
    // rendered rows can change while the reader sits on the list, with no scroll
    // event anywhere. A stale anchor is worse than none — the next Back would
    // faithfully put a row back where it sat before a change the reader has
    // already seen, yanking the list for them.
    let ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const view = () => (
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={ids} />} />
          <Route path="/item/x" element={<div>reader</div>} />
        </Routes>
      </Harness>
    );
    const { rerender } = render(view());
    scrollTo(3 * ROW_HEIGHT); // `d` leads; that's what the anchor records

    // Two polled-in articles arrive at the top while the reader is looking at
    // the list. Nothing scrolls; the rows below simply move down.
    ids = ['new1', 'new2', ...ids];
    rerender(view());
    // The capture watcher hears about it on a microtask, then measures on the
    // next frame.
    await act(async () => {});
    flushFrames();

    // Now they open something and come back, with the list unchanged since.
    act(() => {
      navigate('/item/x');
    });
    act(() => {
      navigate(-1);
    });
    flushFrames();
    // Nothing to correct — they left this view, so this is where they return.
    // On the stale anchor, `d` would be dragged back under the chrome and the
    // reader would land two articles further down than they left.
    expect(scrollY).toBe(3 * ROW_HEIGHT);
  });

  it('does nothing on a Back with no remembered anchor', () => {
    render(
      <Harness>
        <Routes>
          <Route path="/" element={<List ids={['a', 'b', 'c']} />} />
          <Route path="/item/a" element={<div>reader</div>} />
        </Routes>
      </Harness>,
    );
    act(() => {
      navigate('/item/a');
    });
    // A fresh document — a reload, or a PWA relaunched from its last URL — has
    // nothing recorded for this entry, so the browser's own restoration is left
    // to it. Cleared explicitly rather than relying on nothing having been
    // captured, which would make this pass for the wrong reason.
    clearListScrollAnchors();
    act(() => {
      navigate(-1);
    });
    scrollY = 999;
    flushFrames();
    expect(scrollY).toBe(999);
  });
});
