#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# This runs on EVERY session (startup + resume), AFTER Claude Code launches, and
# adds startup latency — so it must stay fast. The heavy, cacheable provisioning
# (installing the Deno runtime + warming Deno's module cache with the Edge
# Functions' npm deps, and the bulk `npm install`) belongs in the environment
# *setup script*, whose filesystem output is snapshotted and reused so it runs
# once instead of every session. See SETUP.md "Cloud environment setup script"
# for the script to paste into the environment config.
#
# With that snapshot in place this hook is nearly a no-op: `npm install`
# reconciles any drift since the snapshot (fast "up to date"), Deno is wired onto
# PATH, and the result is verified. If the setup script ISN'T configured yet,
# the hook falls back to installing Deno itself so edge checks still work — just
# slower for that one session.
set -euo pipefail

# Only provision in the remote (web) sandbox; local machines manage their own.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# Retry a command with exponential backoff — guards each network step against a
# one-off registry/download hiccup within this session's run.
retry() {
  local n=1 max=4 delay=5
  until "$@"; do
    if [ "$n" -ge "$max" ]; then
      echo "[session-start] '$*' failed after $max attempts" >&2
      return 1
    fi
    echo "[session-start] '$*' failed (attempt $n/$max); retrying in ${delay}s..." >&2
    sleep "$delay"
    n=$((n + 1))
    delay=$((delay * 2))
  done
}

DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
DENO_BIN="$DENO_INSTALL/bin/deno"
start=$SECONDS

# --- Node dependencies ----------------------------------------------------
# Reconcile node_modules against the snapshot. When the setup script has already
# installed them this is a fast "up to date"; it only does real work when the
# snapshot is cold or package.json/lock changed. Retried so a transient registry
# failure doesn't leave node_modules half-populated for this session.
echo "[session-start] npm install..."
t=$SECONDS
retry npm install --no-audit --no-fund
echo "[session-start] npm install: $((SECONDS - t))s"

# --- Deno runtime ---------------------------------------------------------
# Provided (and snapshotted) by the setup script. Here we only put it on PATH.
# Fallback: if the snapshot doesn't have it (setup script not added to this
# environment yet), install it now so `deno test`/`deno check` over
# supabase/functions/* still work — best-effort, so a download failure doesn't
# block the whole session.
# Install just the Deno binary (no module cache) — the fallback for when the
# snapshot doesn't already carry it.
install_deno_binary() {
  local version="${DENO_VERSION:-v2.8.3}" target tmp
  case "$(uname -m)" in
    x86_64)        target="x86_64-unknown-linux-gnu" ;;
    aarch64|arm64) target="aarch64-unknown-linux-gnu" ;;
    *) echo "[session-start] Unsupported architecture: $(uname -m)" >&2; return 1 ;;
  esac
  mkdir -p "$DENO_INSTALL/bin"
  tmp="$(mktemp -d)"
  # Chain download → extract → chmod so a failure in ANY step propagates. This
  # function is invoked in an `|| warn` list, which disables errexit inside it,
  # so bare unzip/chmod failures would otherwise be swallowed and the function
  # would return success (the trailing `rm`'s status) with Deno still absent.
  local ok=1
  if retry curl -fsSL -o "$tmp/deno.zip" \
        "https://github.com/denoland/deno/releases/download/${version}/deno-${target}.zip" \
      && unzip -o -q "$tmp/deno.zip" -d "$DENO_INSTALL/bin" \
      && chmod +x "$DENO_BIN"; then
    ok=0
  fi
  rm -rf "$tmp"
  return "$ok"
}

# Reconcile Deno's module cache with the Edge Functions' npm imports
# (@mozilla/readability et al.). Idempotent and fast when the cache is already
# warm (the setup-script snapshot); it only does network work when the cache is
# cold or import_map.json changed since the snapshot. Run it whenever Deno is
# present — NOT just on a fresh install — so a changed import map or an
# evicted/cold cache can't leave `deno check`/`deno test` resolving against a
# stale cache while startup still reports ready (mirrors `npm install` always
# reconciling node_modules).
cache_edge_deps() {
  retry "$DENO_BIN" cache --no-lock --import-map supabase/functions/import_map.json \
    supabase/functions/_shared/fulltext.ts \
    supabase/functions/_shared/parser.ts \
    supabase/functions/_shared/sanitize.ts \
    supabase/functions/_shared/discover.ts
}

if [ ! -x "$DENO_BIN" ]; then
  echo "[session-start] Deno not in snapshot; installing as a fallback." >&2
  echo "[session-start]   → Add the setup script from SETUP.md to this environment so Deno + the" >&2
  echo "[session-start]     edge dep cache are snapshotted and this per-session step is skipped." >&2
  install_deno_binary \
    || echo "[session-start] WARN: Deno fallback install failed; edge checks may not run." >&2
fi

if [ -x "$DENO_BIN" ]; then
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$DENO_INSTALL/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
  export PATH="$DENO_INSTALL/bin:$PATH"
  cache_edge_deps \
    || echo "[session-start] WARN: edge dep cache failed; edge tests may need network." >&2
fi

# --- Verify -------------------------------------------------------------
# Turn a silent "module not found" mid-test into a clear startup signal: confirm
# the deps the build (self-hosted fonts) and the edge unit tests
# (@mozilla/readability et al.) actually resolve from node_modules.
missing=0
for pkg in \
  @fontsource-variable/roboto \
  @fontsource/fira-sans \
  @mozilla/readability \
  linkedom \
  sanitize-html; do
  if [ ! -d "node_modules/$pkg" ]; then
    echo "[session-start] WARN: node_modules/$pkg is missing after install." >&2
    missing=1
  fi
done
if [ "$missing" -eq 0 ]; then
  echo "[session-start] Verified: fonts + edge npm deps present in node_modules."
fi

deno_ver="(deno not installed)"
[ -x "$DENO_BIN" ] && deno_ver="$("$DENO_BIN" --version | head -1)"
echo "[session-start] Ready in $((SECONDS - start))s: $(node --version) / ${deno_ver}"
