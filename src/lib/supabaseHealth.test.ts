// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatSupabaseStatus,
  probeSupabaseHealth,
} from './supabaseHealth';

describe('probeSupabaseHealth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports reachable with rounded latency on any HTTP response', async () => {
    // A 503 still proves we reached the server, so it counts as reachable.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const times = [100, 142.6];
    const now = () => times.shift() ?? 0;

    const health = await probeSupabaseHealth('https://x.supabase.co/auth/v1/health', now);

    expect(health).toEqual({ reachable: true, latencyMs: 43 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports unreachable when the probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    const times = [0, 12];
    const now = () => times.shift() ?? 0;

    const health = await probeSupabaseHealth('https://x.supabase.co/auth/v1/health', now);

    expect(health).toEqual({ reachable: false, latencyMs: 12 });
  });
});

describe('formatSupabaseStatus', () => {
  it('shows a pending probe as checking', () => {
    expect(formatSupabaseStatus({ status: 'checking' })).toBe('checking…');
  });

  it('shows reachability and latency for a settled probe', () => {
    expect(
      formatSupabaseStatus({ status: 'done', health: { reachable: true, latencyMs: 87 } }),
    ).toBe('reachable · 87 ms');
    expect(
      formatSupabaseStatus({ status: 'done', health: { reachable: false, latencyMs: 12 } }),
    ).toBe('unreachable');
  });
});
