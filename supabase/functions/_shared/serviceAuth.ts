// The sole auth gate for the server-to-server Edge Functions (poll, db-perf,
// notify-signup). They're deployed with --no-verify-jwt, so the platform does
// NOT check the caller's JWT — this bearer comparison IS the boundary. The
// scheduler / pg_net trigger sends the service-role key as a Bearer token
// (see SETUP.md); anything else (including a valid user JWT) is rejected
// before the function touches the service client, sends mail, or polls
// publishers.

import { jsonBare } from './respond.ts';

/** Returns the 401 response to send when `req` doesn't carry the
 * service-role bearer, or null when the caller is the service role. */
export function rejectNonServiceCaller(
  req: Request,
  serviceKey: string,
  fnName: string,
): Response | null {
  if ((req.headers.get('Authorization') ?? '') !== `Bearer ${serviceKey}`) {
    console.warn(`${fnName}: rejected request without the service-role bearer`);
    return jsonBare({ error: 'Unauthorized' }, 401);
  }
  return null;
}
