// Readmo → newshacker dismissal mirror — Edge Function.
//
// POST /functions/v1/newshacker-sync { entries: [{ id, at, deleted? }] }
// Forwards a batch of the caller's Done transitions for Hacker News items to
// newshacker's /api/sync, so dismissing an HN story in Readmo also marks it Done
// on newshacker (SPEC.md "Mirror dismissals to newshacker"). `id` is the numeric
// HN item id (derived client-side, see src/lib/newshacker.ts); `deleted` is a
// tombstone for an un-dismiss.
//
// Trust + access:
//   - The caller's JWT identifies the user (userClient.auth.getUser()).
//   - The user's newshacker app token is read with the SERVICE-ROLE client from
//     `newshacker_link` (0050); it's RLS-deny-all to the client and never
//     returned to it. If the user hasn't linked, we return { linked:false } and
//     make no outbound call.
//   - The token is forwarded as `Authorization: Bearer` to newshacker's own
//     /api/sync bearer branch. newshacker.app is a compile-time-constant
//     first-party host (overridable only by the operator via NEWSHACKER_ORIGIN),
//     so there is no user-controlled URL and thus no SSRF surface — this
//     deliberately does NOT route through the generic SSRF helper, which would
//     strip the credential we intend to forward.
//
// Soft by design: any failure returns a 200 envelope ({ linked, ok }) — the
// mirror is best-effort and never blocks or surfaces an error in the reader. The
// local Done state is authoritative regardless.

// @ts-nocheck — runs under Deno, not node/tsc.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

const NEWSHACKER_ORIGIN =
  Deno.env.get('NEWSHACKER_ORIGIN') ?? 'https://newshacker.app';
const NEWSHACKER_SYNC_URL = `${NEWSHACKER_ORIGIN}/api/sync`;
const SYNC_TIMEOUT_MS = 10_000;
const MAX_ENTRIES = 500;

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error('newshacker-sync: unhandled error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

/** Keep only well-formed `{ id:int>0, at:number>=0, deleted?:true }` entries,
 * capped. Anything malformed is dropped rather than failing the batch. */
function normalizeEntries(value: unknown): Array<{ id: number; at: number; deleted?: true }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ id: number; at: number; deleted?: true }> = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== 'number' || !Number.isSafeInteger(e.id) || e.id <= 0) continue;
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at < 0) continue;
    const entry: { id: number; at: number; deleted?: true } = { id: e.id, at: e.at };
    if (e.deleted === true) entry.deleted = true;
    out.push(entry);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth?.user) return json({ error: 'Not authenticated' }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const entries = normalizeEntries((body as Record<string, unknown>)?.entries);
  if (entries.length === 0) return json({ linked: null, ok: true });

  // Read the caller's token (service role bypasses the deny-all RLS on the link).
  const { data: link, error: linkError } = await service
    .from('newshacker_link')
    .select('token')
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (linkError) {
    console.error('newshacker-sync: link read failed:', linkError.message);
    return json({ linked: null, ok: false });
  }
  if (!link?.token) return json({ linked: false, ok: true });

  // Forward to newshacker's /api/sync bearer branch. done-list only.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(NEWSHACKER_SYNC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${link.token}`,
      },
      body: JSON.stringify({ done: entries }),
      signal: controller.signal,
    });
    return json({ linked: true, ok: res.ok, status: res.status });
  } catch (err) {
    console.error('newshacker-sync: forward failed:', err instanceof Error ? err.message : err);
    return json({ linked: true, ok: false });
  } finally {
    clearTimeout(timer);
  }
}
