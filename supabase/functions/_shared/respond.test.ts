// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { jsonCors, jsonBare } from './respond';

describe('jsonCors', () => {
  it('serializes the body with a JSON content type and 200 default', async () => {
    const res = jsonCors({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('echoes the CORS headers so the browser can read the response', () => {
    const res = jsonCors({ ok: true });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('applies the given status and extra headers (e.g. Retry-After)', () => {
    const res = jsonCors({ error: 'rate limited' }, 429, { 'Retry-After': '30' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
  });
});

describe('jsonBare', () => {
  it('serializes the body without CORS headers', async () => {
    const res = jsonBare({ error: 'Unauthorized' }, 401);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});
