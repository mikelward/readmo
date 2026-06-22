/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Supabase project URL. Public (RLS-gated); safe to ship to the client. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon key. Public (RLS-gated); safe to ship to the client. The
   * service-role key must NEVER be exposed as a VITE_* variable. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
