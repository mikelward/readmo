// Readmo database performance diagnostics — Edge Function.
//
// GET /functions/v1/db-perf  ->  { severity, summary, captured_at, active, top }
//
// ATTRIBUTION endpoint: it answers "WHICH query or query group is starving the
// database?" once an out-of-band monitor (Supabase Metrics API → Grafana Cloud)
// has paged that the DB is saturated. See OBSERVABILITY.md for the two-layer
// design and why detection/paging deliberately live OUTSIDE the database.
//
// It calls the read-only `db_perf_diagnostics` RPC (migration 0022) as the
// service role and classifies the result. It performs NO writes — we never add
// load to a database that's already struggling.
//
// Thin entrypoint, same split as poll/notify-signup: the testable logic
// (threshold resolution, classification, summary) lives in
// ../_shared/dbPerf.ts and is unit-tested under vitest. This file only does
// auth + the RPC call + transport, which the sandbox can't run.
//
// Server-to-server only (the operator/Grafana send the service-role key as a
// Bearer token); deploy with `--no-verify-jwt`, like poll.

// @ts-nocheck — runs under Deno, not node/tsc. The _shared module it imports IS
// type-checked + unit-tested.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  classifyDiagnostics,
  resolveLimit,
  resolveThresholds,
} from '../_shared/dbPerf.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error('db-perf: unhandled error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!serviceKey || !supabaseUrl) {
    console.error(
      'db-perf: missing required env:',
      !serviceKey ? 'SUPABASE_SERVICE_ROLE_KEY' : '',
      !supabaseUrl ? 'SUPABASE_URL' : '',
    );
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Service-role only: the RPC reads pg_stat_activity / pg_stat_statements
  // across all sessions (RLS-exempt), so require the service-role bearer before
  // touching it. Deployed with --no-verify-jwt, so this check IS the gate.
  if ((req.headers.get('Authorization') ?? '') !== `Bearer ${serviceKey}`) {
    console.warn('db-perf: rejected request without the service-role bearer');
    return json({ error: 'Unauthorized' }, 401);
  }

  const env = Deno.env.toObject();
  const thresholds = resolveThresholds(env);
  const limit = resolveLimit(env);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.rpc('db_perf_diagnostics', {
    p_active_ms: thresholds.activeMs,
    p_limit: limit,
  });
  if (error) {
    console.error('db-perf: diagnostics RPC failed:', error);
    return json({ error: error.message }, 500);
  }

  const verdict = classifyDiagnostics(data ?? {}, thresholds);
  // Log the one-liner so it also lands in the Edge Function logs (useful when a
  // Grafana alert fired and the operator is reading logs rather than the body).
  console.log(verdict.summary);

  return json({
    severity: verdict.severity,
    summary: verdict.summary,
    captured_at: data?.captured_at ?? null,
    active: data?.active ?? [],
    top: data?.top ?? [],
  });
}
