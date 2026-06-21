import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Tear down the React tree between tests so DOM queries don't leak across
// cases and timers/listeners from one test don't fire in the next.
afterEach(() => {
  cleanup();
});
