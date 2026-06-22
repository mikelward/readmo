#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Provisions the toolchain the sandbox image doesn't ship with:
#   - Node dependencies (vitest / eslint / tsc / vite)
#   - Deno, the Supabase Edge Functions runtime (supabase/functions/*)
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

echo "[session-start] Ready: $(node --version) / $(deno --version | head -1)"
