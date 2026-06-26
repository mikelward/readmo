/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Supabase project URL. Public (RLS-gated); safe to ship to the client. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon key. Public (RLS-gated); safe to ship to the client. The
   * service-role key must NEVER be exposed as a VITE_* variable. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Origin of the newshacker deployment the reader's comments icon links into
   * (the HN discussion for an article). Defaults to https://newshacker.app. */
  readonly VITE_NEWSHACKER_ORIGIN?: string;
  // Fallbacks provisioned by the Supabase↔Vercel integration (public names).
  readonly NEXT_PUBLIC_SUPABASE_URL?: string;
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  readonly NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
