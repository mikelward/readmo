import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom's window.close() tears the whole document down, cascading "document is
// not defined" into every later test. The reader's Done/back ladder
// (closeArticleView) closes the tab when there's no back entry — in a real
// browser that dismisses the tab/Custom Tab back to the OS; in tests we just
// neutralize it so it can't nuke jsdom. Individual tests still spy to assert
// the close branch fired. (location.assign is non-configurable in jsdom, so
// the few tests asserting it replace window.location locally instead.)
beforeEach(() => {
  // Pure-logic tests opt into the node environment (no `window`), so guard.
  if (typeof window !== 'undefined') {
    vi.spyOn(window, 'close').mockImplementation(() => {});
  }
});

// Tear down the React tree between tests so DOM queries don't leak across
// cases and timers/listeners from one test don't fire in the next. Restore
// spies too: vitest 4's `vi.spyOn` returns the *existing* mock when the target
// is already spied (vitest 3 created a fresh spy each call), so without a
// restore the `window.close` spy installed in beforeEach — re-spied by tests
// that assert its call count — would accumulate calls across cases.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
