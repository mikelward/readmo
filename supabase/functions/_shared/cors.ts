// Shared CORS for the browser-invoked Edge Functions (discover, refresh).
//
// Supabase does NOT add CORS headers automatically — each function must answer
// the preflight OPTIONS request and echo these headers on every response, or
// the browser blocks the cross-origin call from the app
// (vercel.app / readmo.app → <ref>.supabase.co). Without this the preflight
// 405s and the actual POST never fires.
//
// A wildcard origin is safe here: these endpoints are authorized by the
// `Authorization`/`apikey` headers (a bearer token, not cookies), so CORS is
// not the security boundary — RLS + the JWT are, and `*` cannot be paired with
// cookie credentials anyway. The allow-headers list covers exactly what
// supabase-js sends on `functions.invoke`.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};

/** Standard preflight reply for an OPTIONS request. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}
