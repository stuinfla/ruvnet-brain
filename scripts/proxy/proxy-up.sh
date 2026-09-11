#!/usr/bin/env bash
# proxy-up.sh — install + start the Meta LLM Proxy, then verify it.
#
# Thin orchestration over rUv's own lifecycle commands (ADR-307):
#   ruflo proxy install / start / status / doctor
# It adds no logic of its own except the macOS workaround documented below.
set -uo pipefail

# Every `ruflo` invocation auto-starts a project background daemon unless this is set (verified
# live: ~/.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/
# daemon-autostart.js:85). Installing/starting the proxy has no business leaving a swarm daemon
# running as a side effect.
export RUFLO_DAEMON_AUTOSTART=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- macOS workaround: upstream bug in @claude-flow/security's PathValidator --
#
# `ruflo proxy install` extracts into a tmpdir and then validates that the
# extracted binary really lives inside that tmpdir (defense against a symlink
# swap). The validator canonicalizes the CANDIDATE path with fs.realpath but
# resolves the ALLOWED PREFIX with path.resolve only:
#
#   path-validator.ts:177-178   prefixes -> path.resolve(p)          (no realpath)
#   path-validator.ts:229,234   candidate -> path.resolve + realpath
#   path-validator.ts:262       resolvedPath.startsWith(prefix + sep)
#
# On macOS os.tmpdir() is /var/folders/... which is a symlink to
# /private/var/folders/... So the candidate becomes /private/var/... while the
# prefix stays /var/... and the startsWith check can NEVER pass. Install fails
# with "extracted binary path failed validation: Path is outside allowed
# directories" for every macOS user.
#
# Handing the installer an ALREADY-CANONICAL TMPDIR makes the validator's own
# assumption true. This changes nothing about what is downloaded or verified —
# the Ed25519 signature and sha256 checks run exactly as before.
#
# Upstream fix would be one line: realpath the prefixes too.
if [ "$(uname -s)" = "Darwin" ]; then
  CANONICAL_TMP="$(node -e 'console.log(require("fs").realpathSync(require("os").tmpdir()))' 2>/dev/null || echo "")"
  if [ -n "$CANONICAL_TMP" ]; then
    export TMPDIR="$CANONICAL_TMP"
    echo "macOS: TMPDIR canonicalized to $TMPDIR (upstream PathValidator symlink bug)"
    echo
  fi
fi

echo "--- install (idempotent; verifies Ed25519 signature + sha256) ---"
if ruflo proxy status --json 2>/dev/null | grep -q '"installed":true'; then
  echo "  already installed"
else
  ruflo proxy install --yes 2>&1 | tail -4 | sed 's/^/  /'
fi
echo

echo "--- start (detached; survives terminal close, NOT a reboot) ---"
if ruflo proxy status --json 2>/dev/null | grep -q '"running":true'; then
  echo "  already running"
else
  ruflo proxy start --service 2>&1 | tail -3 | sed 's/^/  /'
  sleep 2
fi
echo

echo "--- verify ---"
node "$REPO_ROOT/scripts/proxy/proxy-verify.mjs"
