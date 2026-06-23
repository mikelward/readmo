// Injected by Vite's `define` at config-load time (see vite.config.ts).
// Build/deploy metadata for the /debug (and /settings) UI. Fields are ''/0
// when git metadata is unavailable (shallow checkout, tarball) and the UI
// hides the corresponding row.
declare const __BUILD_INFO__: {
  readonly environment: string;
  readonly shortSha: string;
  readonly branch: string;
  readonly commitCount: number;
  readonly commitTime: string;
  readonly commitSubject: string;
  readonly buildTime: string;
};
