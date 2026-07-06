#!/usr/bin/env bash
# gate.sh — rebuild the concepts/capability layer and run the three pass/fail routing gates.
# SEC-0010 #1: this gate must be able to FAIL. Each prove.mjs computes pass!=total -> exit 1
# (scripts/prove.mjs); previously the grep pipe masked that exit code and the script printed
# "GATES COMPLETE" (exit 0) even at 0%. Now every gate's real exit code is captured via
# PIPESTATUS and any miss makes the whole gate exit non-zero. Paths are repo-relative, not
# hardcoded to one machine.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# Model cache: honor an existing KB_MODEL_CACHE; else default to a repo-local dir (no personal path).
export KB_MODEL_CACHE="${KB_MODEL_CACHE:-$PWD/kb/models-cache}"

FAILED=0
run_gate() {  # $1=label  $2..=command
  local label="$1"; shift
  echo "== $label =="
  "$@"
  local rc="${PIPESTATUS[0]}"
  if [ "$rc" -ne 0 ]; then echo "  ✗ GATE FAILED (exit $rc)"; FAILED=1; else echo "  ✓ gate passed"; fi
  echo
}

echo "== rebuild concepts (L2 + primers + capability cards) =="
node scripts/build-concepts.mjs 2>&1 | tail -2
( cd kb && node forge-big.mjs both --dir . --name concepts 2>&1 | tail -2 )
echo

run_gate "GATE 1 — described-need battery (newcomer, no repo names) · target >=85%" \
  node scripts/prove.mjs --questions scripts/described-questions.json --k 2 --out DESCRIBED-PROOF
run_gate "GATE 2 — named/specific battery · must HOLD" \
  node scripts/prove.mjs --questions scripts/proof-questions.json --k 3 --out PROOF
run_gate "GATE 3 — Helix-context demo · target >=6/8" \
  node scripts/prove.mjs --questions scripts/helix-scenario-questions.json --k 2 --out HELIX-DEMO-NOHELIX

if [ "$FAILED" -ne 0 ]; then
  echo "== GATES FAILED — at least one gate missed its threshold. Read DESCRIBED-PROOF.md / PROOF.md / HELIX-DEMO-NOHELIX.md =="
  exit 1
fi
echo "== GATES COMPLETE — all passed. Read DESCRIBED-PROOF.md, PROOF.md, HELIX-DEMO-NOHELIX.md =="
