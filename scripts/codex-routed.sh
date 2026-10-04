#!/usr/bin/env bash
# One routed native noninteractive worker. No silent fallback; model and effort are enforced together.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/model-router-dispatch.mjs" --harness codex -- "$@"
