import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Single browser Supabase client for the whole app. The URL + anon key are
// public (RLS-gated); the service-role key never reaches the client. When the
// env vars are absent (tests, backend-less local/mock dev) the app falls back
// to the mock auth + MockDataSource path, so this module never throws at import
// time — only `getSupabase()` throws, and only if actually called unconfigured.

// Accept our own VITE_* names first, then fall back to the public names the
// Supabase↔Vercel integration provisions (NEXT_PUBLIC_*), so deployments wired
// through that integration work without hand-duplicating env vars. Only public
// keys are read here — never the service-role/secret keys.
const env = import.meta.env;
const url = env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey =
  env.VITE_SUPABASE_ANON_KEY ??
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** Deterministic localStorage key for the persisted auth session. Fixed (rather
 * than supabase-js's default `sb-<ref>-auth-token`) so the boot path can read
 * the signed-in uid synchronously, before first paint — see getActiveUid. */
export const AUTH_STORAGE_KEY = 'readmo:sb-auth';

/** True when both client env vars are present. Drives the auth + data-source
 * selection: configured → real Supabase; unconfigured → mock. */
export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}

/** The configured Supabase project URL (or null when unconfigured). Safe to
 * surface — the URL is public; only the keys are sensitive. */
export function supabaseProjectUrl(): string | null {
  return url ?? null;
}

/** The project ref (`<ref>` in `https://<ref>.supabase.co`), or null. Handy for
 * a diagnostics view to confirm which project the build points at. */
export function supabaseProjectRef(): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

let client: SupabaseClient | null = null;

/** The shared client. Throws if called while unconfigured — callers gate on
 * `isSupabaseConfigured()` first. */
export function getSupabase(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured: set VITE_SUPABASE_URL and ' +
        'VITE_SUPABASE_ANON_KEY (see .env.example).',
    );
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Complete the OAuth redirect: parse the session from the URL on the
        // landing load.
        detectSessionInUrl: true,
        storageKey: AUTH_STORAGE_KEY,
      },
    });
  }
  return client;
}
