// AI call observability — the write side (0067 `ai_call_log`).
//
// Both AI generation paths — the `summary` Edge Function and the poll-time
// spoiler-headline classifier — run through Gemini. This records the OUTCOME of
// each call so the operator can see, at /admin/ai, why the features are (or
// aren't) producing results: the terminal status, the model's HTTP code, the
// item, and a short error.
//
// Deliberately BEST-EFFORT: a logging failure must never affect the call it's
// logging (a summary still returns, a poll still completes). Every write is
// wrapped so it can only warn, never throw. Kept dependency-free (no Deno
// globals) so the same code runs under vitest (node); the caller injects the
// Supabase client. Mirrors the shape of the other `_shared` logic modules.

/** Which generation path made the call. */
export type AiCallKind = 'summary' | 'spoiler';

/** One recorded call outcome. `status` is free text (summary: ok/empty/
 * unavailable/unreachable/accepted; spoiler: rewrite/none/failed) so a new
 * status needs no migration. `httpStatus` is the model's HTTP code when the call
 * reached Gemini, else null. `error` is clamped before storage. */
export interface AiCallEntry {
  kind: AiCallKind;
  status: string;
  httpStatus?: number | null;
  itemId?: string | null;
  error?: string | null;
}

/** Cap a stored error string so a huge model/network message can't bloat a row.
 * Exported for the unit test. */
export const MAX_AI_CALL_ERROR_CHARS = 500;

/** The one DB operation this module needs, injected so it's unit-testable
 * without a live Supabase. `insert` resolves `{ error }` PostgREST-style. */
export interface AiCallLogClient {
  from(table: 'ai_call_log'): {
    insert(row: Record<string, unknown>): Promise<{ error: unknown }>;
  };
}

/** The row this entry becomes — snake_case DB columns. Exported so the test can
 * assert the mapping without reaching into the insert. */
export function aiCallRow(entry: AiCallEntry): Record<string, unknown> {
  const error =
    typeof entry.error === 'string' && entry.error.length > 0
      ? entry.error.slice(0, MAX_AI_CALL_ERROR_CHARS)
      : null;
  return {
    kind: entry.kind,
    status: entry.status,
    http_status: entry.httpStatus ?? null,
    item_id: entry.itemId ?? null,
    error,
  };
}

/**
 * Record one AI call outcome to `ai_call_log`. Best-effort: any failure (a
 * PostgREST error, an unexpected throw, an old backend without the table) is
 * caught and logged, never propagated — the caller's own result is unaffected.
 */
export async function recordAiCall(
  client: AiCallLogClient,
  entry: AiCallEntry,
): Promise<void> {
  try {
    const { error } = await client.from('ai_call_log').insert(aiCallRow(entry));
    if (error) {
      console.warn('ai_call_log: insert failed (non-fatal):', error);
    }
  } catch (err) {
    console.warn('ai_call_log: insert threw (non-fatal):', err);
  }
}
