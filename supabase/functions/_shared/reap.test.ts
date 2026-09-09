// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { reapOrphanFeeds } from './reap.ts';
import type { ReapDbClient } from './reap.ts';

type RpcCall = { fn: string; args?: Record<string, unknown> };

/** In-memory ReapDbClient that records the RPC call and returns a canned result. */
function makeClient(result: { data?: number | null; error?: { message?: string } | null }) {
  const calls: RpcCall[] = [];
  const client: ReapDbClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve({
        data: result.data ?? null,
        error: result.error ?? null,
      });
    },
  };
  return { client, calls };
}

describe('reapOrphanFeeds', () => {
  it('calls the reap_orphan_feeds RPC and returns the reaped count', async () => {
    const { client, calls } = makeClient({ data: 3 });
    const reaped = await reapOrphanFeeds(client);
    expect(reaped).toBe(3);
    expect(calls).toEqual([{ fn: 'reap_orphan_feeds', args: {} }]);
  });

  it('treats a null count (no rows reaped) as 0', async () => {
    const { client } = makeClient({ data: null });
    expect(await reapOrphanFeeds(client)).toBe(0);
  });

  it('throws with the RPC error message so the caller can log it', async () => {
    const { client } = makeClient({ error: { message: 'permission denied' } });
    await expect(reapOrphanFeeds(client)).rejects.toThrow(
      'reap_orphan_feeds failed: permission denied',
    );
  });

  it('throws a generic message when the RPC error carries no message', async () => {
    const { client } = makeClient({ error: {} });
    await expect(reapOrphanFeeds(client)).rejects.toThrow(
      'reap_orphan_feeds failed: unknown error',
    );
  });
});
