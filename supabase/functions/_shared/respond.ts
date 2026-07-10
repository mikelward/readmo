// Shared JSON response builders for the Edge Functions. Every function used
// to declare its own local `json()`; the copies had already drifted on
// header casing and CORS inclusion, so the choice is made explicit here:
//
//  - `jsonCors` — for the browser-invoked functions (discover, refresh,
//    summary, fulltext, newshacker-sync). Echoes the CORS headers on every
//    response; without them the browser blocks the cross-origin call even
//    after a successful preflight.
//  - `jsonBare` — for the server-to-server functions (poll, db-perf,
//    notify-signup), which only the scheduler / DB triggers call. No CORS on
//    purpose: a browser page has no business reading these responses.

import { corsHeaders } from './cors.ts';

export function jsonCors(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders, ...extraHeaders },
  });
}

export function jsonBare(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
