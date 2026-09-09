import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PullToRefresh, PULL_TO_REFRESH_TRIGGER_PX } from './PullToRefresh';

// Component-level wiring test (the gesture math lives in
// usePullToRefresh.test.tsx): the wrapper's pointer handlers must reach the
// hook, the pull must commit an onRefresh, and the indicator must stay an
// accessible live region. Ported from newshacker's PullToRefresh.test.tsx.

function dispatch(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
) {
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(evt, {
    pointerId: 1,
    pointerType: 'touch',
    clientX,
    clientY,
    button: 0,
    buttons: 1,
    isPrimary: true,
  });
  act(() => {
    target.dispatchEvent(evt);
  });
}

describe('<PullToRefresh>', () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders its children', () => {
    render(
      <PullToRefresh onRefresh={() => {}}>
        <div data-testid="child">hello</div>
      </PullToRefresh>,
    );
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('invokes onRefresh when a pull crosses the trigger threshold', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    render(
      <PullToRefresh onRefresh={onRefresh}>
        <div data-testid="child">feed</div>
      </PullToRefresh>,
    );
    const wrap = screen.getByTestId('pull-to-refresh');

    // (dy - start threshold) * resistance must clear the trigger, so drag a
    // comfortable multiple of it.
    const dy = PULL_TO_REFRESH_TRIGGER_PX * 3;
    dispatch(wrap, 'pointerdown', 100, 100);
    dispatch(wrap, 'pointermove', 100, 100 + dy);
    dispatch(wrap, 'pointerup', 100, 100 + dy);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(wrap.getAttribute('data-phase')).toBe('refreshing');

    // Sync onRefresh: after the minimum spin + settle transition the wrapper
    // hands back to idle.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(wrap.getAttribute('data-phase')).toBe('idle');
  });

  it('does not refresh when disabled', () => {
    const onRefresh = vi.fn();
    render(
      <PullToRefresh onRefresh={onRefresh} enabled={false}>
        <div>feed</div>
      </PullToRefresh>,
    );
    const wrap = screen.getByTestId('pull-to-refresh');
    const dy = PULL_TO_REFRESH_TRIGGER_PX * 3;
    dispatch(wrap, 'pointerdown', 100, 100);
    dispatch(wrap, 'pointermove', 100, 100 + dy);
    dispatch(wrap, 'pointerup', 100, 100 + dy);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(wrap.getAttribute('data-phase')).toBe('idle');
  });

  it('exposes an accessible status label for the indicator', () => {
    render(
      <PullToRefresh onRefresh={() => {}}>
        <div>feed</div>
      </PullToRefresh>,
    );
    // role=status + aria-live=polite: screen readers announce refresh state.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
