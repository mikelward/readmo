// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NOTIFY_TO,
  buildSignupEmail,
  resolveRecipient,
  resolveSmtpConfig,
  type SmtpConfig,
} from './signupNotification';

describe('buildSignupEmail', () => {
  it('puts the new user email in the subject and body, default recipient', () => {
    const mail = buildSignupEmail({
      id: 'u-123',
      email: 'ann@example.com',
      created_at: '2026-06-23T10:00:00Z',
    });
    expect(mail.to).toBe(DEFAULT_NOTIFY_TO);
    expect(mail.subject).toBe('New Readmo signup: ann@example.com');
    expect(mail.text).toContain('ann@example.com');
    expect(mail.text).toContain('u-123');
    expect(mail.text).toContain('2026-06-23T10:00:00Z');
  });

  it('honors an explicit recipient', () => {
    const mail = buildSignupEmail({ email: 'a@b.com' }, 'alerts@example.com');
    expect(mail.to).toBe('alerts@example.com');
  });

  it('falls back gracefully when fields are missing', () => {
    const mail = buildSignupEmail({});
    expect(mail.subject).toBe('New Readmo signup: (no email on account)');
    expect(mail.text).toContain('(no email on account)');
    expect(mail.text).toContain('(unknown)');
  });

  it('treats null/undefined fields like missing', () => {
    const mail = buildSignupEmail({ id: null, email: null, created_at: undefined });
    expect(mail.subject).toContain('(no email on account)');
  });

  // SECURITY: the email is OAuth-supplied (untrusted). A CR/LF in it must not be
  // able to inject SMTP headers or split the single-line subject.
  it('strips CR/LF and control chars to prevent header injection', () => {
    const mail = buildSignupEmail({
      email: 'evil@example.com\r\nBcc: victim@example.com',
    });
    expect(mail.subject).not.toContain('\r');
    expect(mail.subject).not.toContain('\n');
    expect(mail.subject).toBe(
      'New Readmo signup: evil@example.com Bcc: victim@example.com',
    );
  });

  it('collapses runs of whitespace into single spaces', () => {
    const mail = buildSignupEmail({ email: '  spaced\t\tout  ' });
    expect(mail.subject).toBe('New Readmo signup: spaced out');
  });
});

describe('resolveRecipient', () => {
  it('defaults to the operator inbox', () => {
    expect(resolveRecipient({})).toBe(DEFAULT_NOTIFY_TO);
  });

  it('uses SIGNUP_NOTIFY_TO when set', () => {
    expect(resolveRecipient({ SIGNUP_NOTIFY_TO: 'ops@example.com' })).toBe(
      'ops@example.com',
    );
  });

  it('ignores a blank override', () => {
    expect(resolveRecipient({ SIGNUP_NOTIFY_TO: '   ' })).toBe(DEFAULT_NOTIFY_TO);
  });
});

describe('resolveSmtpConfig', () => {
  it('errors when SMTP_HOST is absent', () => {
    const cfg = resolveSmtpConfig({ SMTP_FROM: 'a@b.com' });
    expect('error' in cfg).toBe(true);
  });

  it('errors when no sender can be determined', () => {
    const cfg = resolveSmtpConfig({ SMTP_HOST: 'smtp.example.com' });
    expect('error' in cfg).toBe(true);
  });

  it('builds a full config with sensible defaults (implicit TLS on 465)', () => {
    const cfg = resolveSmtpConfig({
      SMTP_HOST: 'smtp.example.com',
      SMTP_USERNAME: 'user@example.com',
      SMTP_PASSWORD: 'secret',
    }) as SmtpConfig;
    expect(cfg.hostname).toBe('smtp.example.com');
    expect(cfg.port).toBe(465);
    expect(cfg.tls).toBe(true);
    expect(cfg.username).toBe('user@example.com');
    expect(cfg.password).toBe('secret');
    expect(cfg.from).toBe('user@example.com'); // falls back to username
  });

  it('defaults to STARTTLS (tls=false) on port 587', () => {
    const cfg = resolveSmtpConfig({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_FROM: 'from@example.com',
    }) as SmtpConfig;
    expect(cfg.port).toBe(587);
    expect(cfg.tls).toBe(false);
    expect(cfg.from).toBe('from@example.com');
  });

  it('lets SMTP_TLS override the port-derived default', () => {
    const cfg = resolveSmtpConfig({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_FROM: 'from@example.com',
      SMTP_TLS: 'true',
    }) as SmtpConfig;
    expect(cfg.tls).toBe(true);
  });

  it('rejects an out-of-range port', () => {
    const cfg = resolveSmtpConfig({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '99999',
      SMTP_FROM: 'from@example.com',
    });
    expect('error' in cfg).toBe(true);
  });

  it('prefers SMTP_FROM over SMTP_USERNAME as the sender', () => {
    const cfg = resolveSmtpConfig({
      SMTP_HOST: 'smtp.example.com',
      SMTP_USERNAME: 'login@example.com',
      SMTP_FROM: 'noreply@example.com',
    }) as SmtpConfig;
    expect(cfg.from).toBe('noreply@example.com');
    expect(cfg.username).toBe('login@example.com');
  });
});
