import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MAX_AI_CALL_ERROR_CHARS,
  aiCallRow,
  recordAiCall,
  type AiCallLogClient,
} from './aiCallLog';

/** A fake PostgREST-ish client that captures the inserted row and returns a
 * configurable `{ error }`. */
function fakeClient(error: unknown = null) {
  const inserts: Array<Record<string, unknown>> = [];
  const client: AiCallLogClient = {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          return Promise.resolve({ error });
        },
      };
    },
  };
  return { client, inserts };
}

describe('aiCallRow', () => {
  it('maps camelCase entry fields to snake_case columns', () => {
    expect(
      aiCallRow({
        kind: 'spoiler',
        status: 'rewrite',
        httpStatus: 200,
        itemId: 'item-1',
        error: null,
      }),
    ).toEqual({
      kind: 'spoiler',
      status: 'rewrite',
      http_status: 200,
      item_id: 'item-1',
      error: null,
    });
  });

  it('defaults absent optional fields to null', () => {
    expect(aiCallRow({ kind: 'summary', status: 'unavailable' })).toEqual({
      kind: 'summary',
      status: 'unavailable',
      http_status: null,
      item_id: null,
      error: null,
    });
  });

  it('clamps a long error string and normalizes an empty one to null', () => {
    const row = aiCallRow({
      kind: 'summary',
      status: 'unreachable',
      error: 'x'.repeat(MAX_AI_CALL_ERROR_CHARS + 200),
    });
    expect((row.error as string).length).toBe(MAX_AI_CALL_ERROR_CHARS);
    expect(aiCallRow({ kind: 'summary', status: 'ok', error: '' }).error).toBeNull();
  });
});

describe('recordAiCall', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('inserts the mapped row', async () => {
    const { client, inserts } = fakeClient();
    await recordAiCall(client, {
      kind: 'spoiler',
      status: 'failed',
      httpStatus: 503,
      itemId: 'item-9',
      error: 'timeout',
    });
    expect(inserts).toEqual([
      {
        kind: 'spoiler',
        status: 'failed',
        http_status: 503,
        item_id: 'item-9',
        error: 'timeout',
      },
    ]);
  });

  it('never throws on a PostgREST error (best-effort)', async () => {
    const { client } = fakeClient({ code: 'PGRST205', message: 'no table' });
    await expect(
      recordAiCall(client, { kind: 'summary', status: 'ok' }),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('never throws when the client itself throws', async () => {
    const client: AiCallLogClient = {
      from() {
        throw new Error('boom');
      },
    };
    await expect(
      recordAiCall(client, { kind: 'summary', status: 'ok' }),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});
