// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { corsHeaders, preflight } from './cors';

describe('cors', () => {
  it('allows the cross-origin POST + the headers supabase-js sends', () => {
    expect(corsHeaders['Access-Control-Allow-Origin']).toBe('*');
    const methods = corsHeaders['Access-Control-Allow-Methods'];
    expect(methods).toContain('POST');
    expect(methods).toContain('OPTIONS');
    const allowed = corsHeaders['Access-Control-Allow-Headers'].toLowerCase();
    for (const h of ['authorization', 'apikey', 'content-type', 'x-client-info']) {
      expect(allowed).toContain(h);
    }
  });

  it('preflight() answers OPTIONS with 204 + the CORS headers', () => {
    const res = preflight();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
  });
});
