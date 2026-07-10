// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { rejectNonServiceCaller } from './serviceAuth';

const KEY = 'service-role-key-123';

function req(auth?: string): Request {
  return new Request('https://example.com/functions/v1/poll', {
    method: 'POST',
    headers: auth ? { Authorization: auth } : {},
  });
}

describe('rejectNonServiceCaller', () => {
  it('admits exactly the service-role bearer', () => {
    expect(rejectNonServiceCaller(req(`Bearer ${KEY}`), KEY, 'poll')).toBeNull();
  });

  it('rejects a missing Authorization header with 401', async () => {
    const res = rejectNonServiceCaller(req(), KEY, 'poll');
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a non-service token (e.g. a user JWT or the anon key)', () => {
    expect(rejectNonServiceCaller(req('Bearer some-user-jwt'), KEY, 'poll')?.status).toBe(401);
    expect(rejectNonServiceCaller(req(KEY), KEY, 'poll')?.status).toBe(401); // no Bearer prefix
    expect(
      rejectNonServiceCaller(req(`Bearer ${KEY}x`), KEY, 'poll')?.status,
    ).toBe(401); // exact match, no trailing junk
  });
});
