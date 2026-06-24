import type { ConnectivityStatus } from './networkStatus';

/** Copy for a load-failure panel. `headline` is friendly and names the action
 * that failed; `detail` is a short, curated pointer at the cause shown behind a
 * "Details" disclosure (so it's reachable on mobile, where the console isn't,
 * without low-level noise in the user's face). `detail` is null when there's
 * nothing readable or when the failure is a plain connectivity state. */
export interface LoadFailureCopy {
  headline: string;
  detail: string | null;
}

export interface LoadFailureContext {
  /** Verb phrase naming the failed action, e.g. "fetching the feed list" →
   *  "Unexpected response fetching the feed list." Keep it user-facing. */
  action: string;
  /** Noun for what couldn't load, used in the offline/fallback lines, e.g.
   *  "items" → "Reconnect to load items." */
  noun: string;
  /** Override for the offline headline. The reader uses a bespoke line about
   *  pinning for offline rather than "reconnect to load …". */
  offline?: string;
}

/**
 * Decide load-failure copy from the two things that actually determine it: the
 * connectivity status and the read's error. The previous feed copy keyed off
 * status alone and claimed "server isn't responding" for *every* non-offline
 * failure — including an online read where the server answered with an error,
 * which was simply untrue. Order is deliberate:
 *
 *   1. offline             — no network; reconnecting is the fix and any caught
 *                            error is a symptom, so we don't surface it.
 *   2. backend-unreachable — reached the network but the backend didn't answer.
 *                            The ONLY case where "isn't responding" is true.
 *                            Checked before `error` so the internal empty-confirm
 *                            sentinel never leaks to the user.
 *   3. online + error      — the server responded, with an error. Name the
 *                            action and show a curated detail instead of blaming
 *                            the connection.
 *   4. fallback            — online, no error, still in the miss-state (e.g. an
 *                            empty result we couldn't confirm).
 */
export function loadFailureCopy(
  status: ConnectivityStatus,
  error: unknown,
  ctx: LoadFailureContext,
): LoadFailureCopy {
  if (status === 'offline') {
    return {
      headline: ctx.offline ?? `You’re offline. Reconnect to load ${ctx.noun}.`,
      detail: null,
    };
  }
  if (status === 'backend-unreachable') {
    return {
      headline: 'Readmo’s server isn’t responding right now — it may be busy.',
      detail: null,
    };
  }
  if (error != null) {
    return {
      headline: `Unexpected response ${ctx.action}.`,
      detail: presentableDetail(error),
    };
  }
  return { headline: `Couldn’t load ${ctx.noun}.`, detail: null };
}

/** The pointer-at-the-cause shown behind the "Details" disclosure. This is the
 * SAME message we hand to console.error — the guiding rule: anything safe to log
 * is safe to render (and the user is usually on mobile, where the console isn't
 * visible, so we lean toward showing it). If a message were ever too sensitive
 * to show here, it'd be too sensitive to return to the client at all — that's a
 * server-side concern to fix at the source, not something to paper over by
 * hiding it in the UI. We surface the human-readable message only (not a raw
 * object/stack — console.error still gets the whole thing). Null when empty. */
export function presentableDetail(error: unknown): string | null {
  const msg = errorMessage(error);
  if (!msg) return null;
  const trimmed = msg.trim();
  return trimmed || null;
}

/** Best-effort plain-text message from whatever was thrown. */
export function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message || null;
  if (typeof error === 'string') return error || null;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message) || null;
  }
  return null;
}
