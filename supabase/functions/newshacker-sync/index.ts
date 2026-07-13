// Readmo ↔ newshacker Done/Pinned sync — Edge Function.
//
// POST /functions/v1/newshacker-sync   (push: Readmo → newshacker)
//   { entries: [{ id, at, deleted? }],   // Done list (legacy key name, kept so
//     pinned:  [{ id, at, deleted? }] }   // an older client still mirrors Done)
// Forwards a batch of the caller's Done and Pinned transitions for Hacker News
// items to newshacker's /api/sync, so dismissing or pinning an HN story in Readmo
// also updates newshacker's matching list (SPEC.md "Mirror dismissals and pins to
// newshacker"). `id` is the numeric HN item id (derived client-side, see
// src/lib/newshacker.ts); `deleted` is a tombstone for an un-dismiss / unpin.
//
// GET /functions/v1/newshacker-sync    (pull: newshacker → Readmo, Done only)
//   → { linked, applied }
// Fetches newshacker's own Done + Pinned lists (GET /api/sync with the same
// bearer token) and applies them to the caller's item_state via the
// `apply_newshacker_state` RPC (0063; falls back to the Done-only 0062
// `apply_newshacker_dones` when 0063 isn't deployed yet), mapping each HN id
// back to a Readmo item the user subscribes to. This is the reverse half of the
// mirror — e.g. once you open a story on newshacker and mark it Done there, it
// flows back and dismisses it in Readmo; pinning there pins it here too.
// The RPC runs as the CALLER (userClient, so auth.uid() is the account and RLS
// applies), not the service role. `applied` counts item_state writes carrying
// NEW information (0 when nothing mapped or everything was already in sync —
// the 0065 RPC skips no-op re-applies); the client re-hydrates when it's > 0.
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
// Soft by design: any failure returns a 200 envelope ({ linked, ok/applied }) —
// the sync is best-effort and never blocks or surfaces an error in the reader.
// The local Done state is authoritative regardless.

// @ts-nocheck — runs under Deno, not node/tsc.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { preflight } from '../_shared/cors.ts';
import { jsonCors as json } from '../_shared/respond.ts';
import { extractDoneEntries, extractPinnedEntries } from '../_shared/newshackerPull.ts';

const NEWSHACKER_ORIGIN =
  Deno.env.get('NEWSHACKER_ORIGIN') ?? 'https://newshacker.app';
const NEWSHACKER_SYNC_URL = `${NEWSHACKER_ORIGIN}/api/sync`;
const SYNC_TIMEOUT_MS = 10_000;
const MAX_ENTRIES = 500;
// Cap the reverse pull: newshacker's Done list can hold up to 10k entries, but
// only recent ones map to items still inside Readmo's freshness window.
// extractDoneEntries keeps the newest `PULL_MAX`.
const PULL_MAX = 1000;

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error('newshacker-sync: unhandled error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

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
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ error: 'GET or POST only' }, 405);
  }

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

  // Read the caller's token once (service role bypasses the deny-all RLS on the
  // link). Both directions need it; if the user hasn't linked, neither runs.
  const { data: link, error: linkError } = await service
    .from('newshacker_link')
    .select('token')
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (linkError) {
    console.error('newshacker-sync: link read failed:', linkError.message);
    return json({ linked: null, ok: false });
  }
  const token = link?.token as string | undefined;

  return req.method === 'GET'
    ? await handlePull(userClient, token)
    : await handlePush(req, token);
}

/** POST: forward the caller's Done/Pinned transitions to newshacker. */
async function handlePush(req: Request, token: string | undefined): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const b = (body as Record<string, unknown>) ?? {};
  const done = normalizeEntries(b.entries);
  const pinned = normalizeEntries(b.pinned);
  if (done.length === 0 && pinned.length === 0) {
    return json({ linked: null, ok: true });
  }
  if (!token) return json({ linked: false, ok: true });

  // Forward to newshacker's /api/sync bearer branch (done + pinned lists).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(NEWSHACKER_SYNC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ done, pinned }),
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

/** GET: pull newshacker's own Done + Pinned lists and apply them to the caller's
 * item_state (reverse sync). Runs the RPC as the caller (userClient) so
 * auth.uid() is the account and RLS applies. Best-effort throughout.
 *
 * `ok` reports whether the round-trip actually CONSULTED newshacker and
 * applied its lists — false when the outbound fetch failed/non-2xx or the
 * apply RPC errored. The client's reverse-pull coordinator needs the
 * distinction: an "applied: 0" from a newshacker outage must not be read as
 * "newshacker answered: nothing changed", or a handoff card's syncing marker
 * would settle on an answer nobody gave. Additive — an older client simply
 * ignores the field. */
async function handlePull(
  userClient: ReturnType<typeof createClient>,
  token: string | undefined,
): Promise<Response> {
  if (!token) return json({ linked: false, applied: 0, ok: true });

  // Fetch newshacker's full sync state via its bearer branch, then keep the
  // Done + Pinned lists.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  let dones: ReturnType<typeof extractDoneEntries>;
  let pins: ReturnType<typeof extractPinnedEntries>;
  try {
    const res = await fetch(NEWSHACKER_SYNC_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return json({ linked: true, applied: 0, ok: false });
    const body = await res.json();
    dones = extractDoneEntries(body, PULL_MAX);
    pins = extractPinnedEntries(body, PULL_MAX);
  } catch (err) {
    console.error('newshacker-sync: pull fetch failed:', err instanceof Error ? err.message : err);
    return json({ linked: true, applied: 0, ok: false });
  } finally {
    clearTimeout(timer);
  }
  if (dones.length === 0 && pins.length === 0) {
    return json({ linked: true, applied: 0, ok: true });
  }

  const { data, error } = await userClient.rpc('apply_newshacker_state', {
    p_dones: dones,
    p_pins: pins,
  });
  if (error) {
    // Fall back to the Done-only RPC (0062) if the general one (0063) isn't
    // deployed yet, so the reverse pull still works on an older backend.
    if (error.code === 'PGRST202' && dones.length > 0) {
      const { data: d2, error: e2 } = await userClient.rpc('apply_newshacker_dones', {
        p_entries: dones,
      });
      if (!e2) {
        return json({ linked: true, applied: typeof d2 === 'number' ? d2 : 0, ok: true });
      }
      console.error('newshacker-sync: apply (fallback) failed:', e2.message);
      return json({ linked: true, applied: 0, ok: false });
    }
    console.error('newshacker-sync: apply failed:', error.message);
    return json({ linked: true, applied: 0, ok: false });
  }
  return json({ linked: true, applied: typeof data === 'number' ? data : 0, ok: true });
}
