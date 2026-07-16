import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { AiCallsPage } from './AiCallsPage';
import { MockDataSource } from '../lib/data/MockDataSource';
import { renderWithProviders } from '../test/renderWithProviders';
import type { AiCall, AiCallCount, Capabilities } from '../lib/data/DataSource';

class CapsSource extends MockDataSource {
  constructor(private readonly caps: Capabilities) {
    super(`test-${Math.random()}`);
  }
  async getCapabilities(): Promise<Capabilities> {
    return this.caps;
  }
}

/** A source with no recorded calls, to exercise the empty state. */
class EmptySource extends MockDataSource {
  async listAiCalls(): Promise<AiCall[]> {
    return [];
  }
  async getAiCallCounts(): Promise<AiCallCount[]> {
    return [];
  }
}

function render(source?: MockDataSource) {
  return renderWithProviders(<AiCallsPage />, {
    source: source ?? new MockDataSource(`test-${Math.random()}`),
    route: '/admin/ai',
  });
}

describe('AiCallsPage', () => {
  // The capability query is gated on a signed-in user.
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  it('shows a not-authorized message for a non-admin', async () => {
    renderWithProviders(<AiCallsPage />, {
      source: new CapsSource({ family: false, admin: false, allowlistArmed: false }),
      route: '/admin/ai',
    });
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
    expect(screen.queryByTestId('ai-calls-list')).not.toBeInTheDocument();
  });

  it('lists recent AI calls with their kind, status, and item', async () => {
    render();
    const list = await screen.findByTestId('ai-calls-list');
    const rows = within(list).getAllByTestId('ai-call-row');
    // The mock seeds a spread of summary + spoiler calls.
    expect(rows.length).toBeGreaterThanOrEqual(6);
    // A successful summary and its article title.
    expect(list).toHaveTextContent('ok');
    expect(list).toHaveTextContent(
      'A foldable phone that actually folds flat, finally',
    );
    // A failed spoiler call surfaces its Gemini HTTP code and error.
    expect(list).toHaveTextContent('failed');
    expect(list).toHaveTextContent('Gemini HTTP 503');
  });

  it('summarizes the last-24h tally by kind, including the key-unset signal', async () => {
    render();
    // Both kind cards render; the "unavailable" status (key unset) shows so the
    // operator can spot a misconfigured deployment at a glance.
    expect(await screen.findByText('Article summaries')).toBeInTheDocument();
    expect(screen.getByText('Spoiler-free headlines')).toBeInTheDocument();
    expect(screen.getByText(/unavailable/)).toBeInTheDocument();
  });

  it('shows a blocked summary with its HTTP status and reason detail', async () => {
    // A page the summary path couldn't read is recorded as `blocked`; the
    // operator sees the publisher HTTP code (chip) and the block reason (detail).
    class BlockedSource extends MockDataSource {
      async listAiCalls(): Promise<AiCall[]> {
        return [
          {
            kind: 'summary',
            status: 'blocked',
            httpStatus: 403,
            itemId: 'item-blocked',
            itemTitle: 'My son’s passport combo',
            error: 'blocked: fetch returned HTTP 403',
            createdAt: '2026-07-16T20:00:00Z',
          },
        ];
      }
      async getAiCallCounts(): Promise<AiCallCount[]> {
        return [{ kind: 'summary', status: 'blocked', count: 1 }];
      }
    }
    render(new BlockedSource(`test-${Math.random()}`));
    const row = await screen.findByTestId('ai-call-row');
    expect(row).toHaveTextContent('blocked');
    expect(row).toHaveTextContent('403');
    expect(row).toHaveTextContent('blocked: fetch returned HTTP 403');
  });

  it('shows an empty state when nothing has been recorded', async () => {
    render(new EmptySource(`test-${Math.random()}`));
    expect(await screen.findByTestId('ai-calls-empty')).toHaveTextContent(
      /no ai calls recorded/i,
    );
  });
});
