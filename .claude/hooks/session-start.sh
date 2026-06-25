#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Provisions the toolchain the sandbox image doesn't ship with:
#   - Node dependencies (vitest / eslint / tsc / vite)
#   - Deno, the Supabase Edge Functions runtime (supabase/functions/*)
#   - The Edge Functions' npm deps in Deno's own cache (@mozilla/readability,
#     linkedom, sanitize-html, fast-xml-parser, entities) so `deno test` /
#     `deno check` on supabase/functions/* resolve offline instead of failing
#     mid-test with "module not found".
#
# Deno's official installer downloads from dl.deno.land, which the sandbox
# network policy blocks (403). GitHub release assets are reachable, so we
# fetch the release archive from there instead.
set -euo pipefail

# Only provision in the remote (web) sandbox; local machines manage their own.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

echo "[session-start] Installing Node dependencies (npm install)..."
npm install --no-audit --no-fund

# --- Deno (Supabase Edge Functions runtime) -------------------------------
DENO_VERSION="${DENO_VERSION:-v2.8.3}"
DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
DENO_BIN="$DENO_INSTALL/bin/deno"

case "$(uname -m)" in
  x86_64)        DENO_TARGET="x86_64-unknown-linux-gnu" ;;
  aarch64|arm64) DENO_TARGET="aarch64-unknown-linux-gnu" ;;
  *) echo "[session-start] Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ -x "$DENO_BIN" ] && "$DENO_BIN" --version 2>/dev/null | grep -q "deno ${DENO_VERSION#v} "; then
  echo "[session-start] Deno ${DENO_VERSION} already installed."
else
  echo "[session-start] Installing Deno ${DENO_VERSION} from GitHub releases..."
  mkdir -p "$DENO_INSTALL/bin"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  url="https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-${DENO_TARGET}.zip"
  curl -fsSL --retry 3 -o "$tmp/deno.zip" "$url"
  unzip -o -q "$tmp/deno.zip" -d "$DENO_INSTALL/bin"
  chmod +x "$DENO_BIN"
fi

# Persist Deno on PATH for the rest of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$DENO_INSTALL/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
export PATH="$DENO_INSTALL/bin:$PATH"

# --- Edge Function npm deps (Deno's cache) --------------------------------
# The Supabase Edge Functions import npm packages (@mozilla/readability,
# linkedom, sanitize-html, fast-xml-parser, entities) via the import map. The
# `npm install` above only populates node_modules for the Node/Vitest side;
# Deno keeps a *separate* module cache, so without this step a `deno test` or
# `deno check` over supabase/functions/* tries to reach the network mid-run and
# fails with "module not found" (e.g. @mozilla/readability). Pre-fetch them so
# the edge checks run offline.
#
# We deliberately cache the pure _shared logic modules, not the function
# entrypoints: the entrypoints import @supabase/supabase-js from jsr.io, which
# the sandbox network policy blocks (403). These four modules pull every mapped
# npm package from the (reachable) npm registry between them. Best-effort: a
# registry hiccup shouldn't abort session startup.
echo "[session-start] Pre-caching Edge Function npm deps into Deno's cache..."
if deno cache --no-lock --import-map supabase/functions/import_map.json \
    supabase/functions/_shared/fulltext.ts \
    supabase/functions/_shared/parser.ts \
    supabase/functions/_shared/sanitize.ts \
    supabase/functions/_shared/discover.ts; then
  echo "[session-start] Edge Function npm deps cached."
else
  echo "[session-start] WARN: deno cache of edge deps failed; edge tests may need network." >&2
fi

echo "[session-start] Ready: $(node --version) / $(deno --version | head -1)"
