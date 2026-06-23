// Injected by Vite's `define` at config-load time (see vite.config.ts). None
// are secret (git metadata + the public VERCEL_ENV); each is '' when the
// metadata is unavailable (shallow checkout, tarball), and the UI degrades.

/** ISO commit timestamp of the deployed bundle. */
declare const __BUILD_COMMIT_TIME__: string;
/** Full git commit SHA of the deployed bundle. */
declare const __BUILD_SHA__: string;
/** Total commit count on the built ref (`git rev-list --count HEAD`); '' on a
 * shallow clone. Used as the production "build number". */
declare const __BUILD_COMMIT_COUNT__: string;
/** Git branch/ref the bundle was built from. */
declare const __BUILD_REF__: string;
/** Deploy environment: 'production' | 'preview' | 'development' (VERCEL_ENV). */
declare const __BUILD_ENV__: string;
