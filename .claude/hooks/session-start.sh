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

# Point git at the version-controlled hooks (.githooks/pre-commit guards against
# duplicate migration ids). core.hooksPath is per-clone local config, so the
# fresh web-sandbox clone needs this set each session.
echo "[session-start] Wiring git hooks (core.hooksPath=.githooks)..."
git config core.hooksPath .githooks || true

# --- Node (the major pinned by .nvmrc) ------------------------------------
# The sandbox image ships whatever Node it ships; CI and Vercel build on the
# .nvmrc major. Left alone, every check we run here would pass on a different
# runtime than the one that ships — so provision the pinned major first, before
# `npm install` builds native deps (sharp) against an ABI.
#
# Best-effort: a nodejs.org hiccup shouldn't abort session startup, and the
# image's Node is a workable fallback for everything except runtime-version
# questions.
NODE_MAJOR="$(tr -d '[:space:]' < .nvmrc)"
NODE_ROOT="${NODE_ROOT:-$HOME/.node}"

install_node() {
  local resolved arch url dir tmp
  case "$(uname -m)" in
    x86_64)        arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "[session-start] WARN: no Node build for $(uname -m)" >&2; return 1 ;;
  esac

  # Resolve the newest release on that major with the Node already present.
  resolved="$(curl -fsSL --retry 3 https://nodejs.org/dist/index.json |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const r=JSON.parse(s).find(r=>r.version.startsWith("v"+process.argv[1]+"."));
      process.stdout.write(r?r.version:"");})' "$NODE_MAJOR")" || return 1
  [ -n "$resolved" ] || return 1

  dir="$NODE_ROOT/node-$resolved-linux-$arch"
  if [ ! -x "$dir/bin/node" ]; then
    mkdir -p "$NODE_ROOT"
    tmp="$(mktemp -d)"
    url="https://nodejs.org/dist/$resolved/node-$resolved-linux-$arch.tar.xz"
    curl -fsSL --retry 3 -o "$tmp/node.tar.xz" "$url" || { rm -rf "$tmp"; return 1; }
    tar -xJf "$tmp/node.tar.xz" -C "$NODE_ROOT" || { rm -rf "$tmp"; return 1; }
    rm -rf "$tmp"
  fi

  [ -x "$dir/bin/node" ] || return 1
  # Persist for the rest of the session, same mechanism as Deno below.
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$dir/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
  export PATH="$dir/bin:$PATH"
}

if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = "$NODE_MAJOR" ]; then
  echo "[session-start] Node ${NODE_MAJOR}.x already active."
elif install_node; then
  echo "[session-start] Node $(node --version) active (.nvmrc pins ${NODE_MAJOR})."
else
  echo "[session-start] WARN: could not provision Node ${NODE_MAJOR}; staying on $(node --version)." >&2
fi

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
