// Readmo signup notifier — Edge Function.
//
// POST /functions/v1/notify-signup { id, email, created_at }
//
// Invoked by the AFTER INSERT trigger on `auth.users` (migration 0012) via
// pg_net: whenever a new account is created, this emails the operator over SMTP
// so they know someone signed up. The trigger sends the service-role key as a
// Bearer token; we verify it here and deploy with `--no-verify-jwt`, mirroring
// the `poll` function (server-to-server, not browser-invoked).
//
// Thin entrypoint: the testable logic (email construction, SMTP/recipient
// config) lives in ../_shared/signupNotification.ts and is unit-tested under
// vitest. This file only does auth + transport, which the test sandbox can't
// run (no Deno, no SMTP socket) — same split as poll/refresh.

// @ts-nocheck — runs under Deno, not node/tsc. The _shared module it imports
// IS type-checked + unit-tested.
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
import {
  buildSignupEmail,
  resolveRecipient,
  resolveSmtpConfig,
} from '../_shared/signupNotification.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    console.warn(`notify-signup: rejected ${req.method} (POST only)`);
    return json({ error: 'POST only' }, 405);
  }

  // Server-to-server only: the DB trigger calls us with the service-role key as
  // a Bearer token. Require it before doing any work so a stray request (or any
  // holder of a non-service JWT) can't make us send mail. The function is
  // deployed with --no-verify-jwt, so this check IS the gate.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if ((req.headers.get('Authorization') ?? '') !== `Bearer ${serviceKey}`) {
    console.warn('notify-signup: rejected request without the service-role bearer');
    return json({ error: 'Unauthorized' }, 401);
  }

  const smtp = resolveSmtpConfig(Deno.env.toObject());
  if ('error' in smtp) {
    // Misconfiguration: log + 500. The trigger is fire-and-forget (pg_net), so
    // this never blocks or rolls back the signup itself.
    console.error('notify-signup: SMTP not configured:', smtp.error);
    return json({ error: smtp.error }, 500);
  }

  const event = await req.json().catch(() => ({}));
  const mail = buildSignupEmail(event, resolveRecipient(Deno.env.toObject()));

  const client = new SMTPClient({
    connection: {
      hostname: smtp.hostname,
      port: smtp.port,
      tls: smtp.tls,
      auth:
        smtp.username && smtp.password
          ? { username: smtp.username, password: smtp.password }
          : undefined,
    },
  });

  try {
    await client.send({
      from: smtp.from,
      to: mail.to,
      subject: mail.subject,
      content: mail.text,
    });
    await client.close();
    console.log(`notify-signup: email sent to ${mail.to} for user ${event.id ?? '(unknown)'}`);
  } catch (err) {
    console.error('notify-signup: SMTP send failed:', err);
    try {
      await client.close();
    } catch {
      /* already closed */
    }
    return json({ error: 'send failed' }, 502);
  }

  return json({ ok: true });
});
