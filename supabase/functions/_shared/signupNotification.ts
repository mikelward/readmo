// Signup notification — pure, testable logic for the `notify-signup` Edge
// Function.
//
// When a new user is created in `auth.users`, a DB trigger posts the new row to
// the `notify-signup` function (see migration 0012), which emails the operator
// over SMTP. This module holds the parts that are pure and unit-testable: the
// SMTP config + recipient resolution and the email body construction. The
// transport (denomailer over TCP) stays in the thin Deno entrypoint, which is
// not run in the vitest sandbox — same split as poll/refresh.
//
// SECURITY: the new user's email/name come from the OAuth provider and are
// therefore UNTRUSTED. They land in the email subject (a header) and body, so
// every interpolated value is forced to a single line (CR/LF + control chars
// stripped) to foreclose SMTP header injection. The body is plain text, so
// there is no HTML to inject into.

/** Default operator inbox for signup alerts (overridable via SIGNUP_NOTIFY_TO). */
export const DEFAULT_NOTIFY_TO = 'mikel@mikelward.com';

/** The new-user payload the trigger sends (all fields untrusted/optional). */
export interface SignupEvent {
  id?: string | null;
  email?: string | null;
  created_at?: string | null;
}

/** A plain-text email ready to hand to the SMTP transport. */
export interface SignupEmail {
  to: string;
  subject: string;
  text: string;
}

/** Resolved SMTP connection settings (from the Functions environment). */
export interface SmtpConfig {
  hostname: string;
  port: number;
  /** Implicit TLS on connect (port 465). 587/25 negotiate STARTTLS instead. */
  tls: boolean;
  username?: string;
  password?: string;
  from: string;
}

type Env = Record<string, string | undefined>;

// Collapse any untrusted value to a single trimmed line: drop CR/LF and other
// control characters (which could inject SMTP headers or split the subject),
// then squeeze runs of whitespace. Empty/whitespace-only input -> ''.
function oneLine(value: unknown): string {
  if (value == null) return '';
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The address signup alerts are sent to (env override -> default operator). */
export function resolveRecipient(env: Env): string {
  return oneLine(env.SIGNUP_NOTIFY_TO) || DEFAULT_NOTIFY_TO;
}

/**
 * Resolve SMTP settings from the environment, or return an explanatory error
 * string when the config is incomplete (so the entrypoint can 500 clearly
 * instead of throwing deep inside the transport).
 */
export function resolveSmtpConfig(env: Env): SmtpConfig | { error: string } {
  const hostname = oneLine(env.SMTP_HOST);
  if (!hostname) return { error: 'SMTP_HOST is not set' };

  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : 465;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { error: `SMTP_PORT is invalid: ${env.SMTP_PORT}` };
  }

  // Implicit TLS defaults on for the SMTPS port (465); STARTTLS ports
  // (587/25) connect cleartext then upgrade. SMTP_TLS overrides explicitly.
  let tls = port === 465;
  if (env.SMTP_TLS != null && env.SMTP_TLS !== '') {
    tls = /^(1|true|yes)$/i.test(env.SMTP_TLS.trim());
  }

  const username = oneLine(env.SMTP_USERNAME) || undefined;
  const password = env.SMTP_PASSWORD || undefined;
  const from = oneLine(env.SMTP_FROM) || username;
  if (!from) {
    return { error: 'SMTP_FROM (or SMTP_USERNAME) is required as the sender' };
  }

  return { hostname, port, tls, username, password, from };
}

/** Build the plain-text signup-alert email for the given event + recipient. */
export function buildSignupEmail(
  event: SignupEvent,
  recipient: string = DEFAULT_NOTIFY_TO,
): SignupEmail {
  const email = oneLine(event.email) || '(no email on account)';
  const id = oneLine(event.id) || '(unknown)';
  const createdAt = oneLine(event.created_at) || '(unknown)';

  const subject = `New Readmo signup: ${email}`;
  const text = [
    'A new user just signed up for Readmo.',
    '',
    `Email:      ${email}`,
    `User ID:    ${id}`,
    `Created at: ${createdAt}`,
    '',
    '— Readmo signup notifier',
  ].join('\n');

  return { to: recipient, subject, text };
}
