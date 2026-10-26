#!/bin/sh
# notify.sh "<title>" "<message>" [priority] [tags] — push alert to Stuart's phone via ntfy.sh.
# Topic from $NTFY_TOPIC or the project .env. Alerting must never break a pipeline (no caller runs under
# `set -e`), but the exit code now tells the truth so a caller can record delivery (4.7.21):
#   0 delivered (2xx) · 1 not delivered (network or HTTP error; curl --fail) · 2 paging off (NTFY_TOPIC="" or no topic)
# NTFY_TOPIC set-but-EMPTY is an explicit opt-out (job-heartbeat.sh's convention): it never falls through to .env.
DIR=$(dirname "$0")
if [ "${NTFY_TOPIC+set}" = "set" ]; then TOPIC="$NTFY_TOPIC"
else TOPIC="$(grep -m1 '^NTFY_TOPIC=' "$DIR/../.env" 2>/dev/null | cut -d= -f2)"; fi
[ -z "$TOPIC" ] && exit 2
curl -sS --fail --max-time 10 \
  -H "Title: ${1:-RuvNet Brain}" \
  -H "Priority: ${3:-default}" \
  -H "Tags: ${4:-brain}" \
  -d "${2:-(no message)}" \
  "${NTFY_URL:-https://ntfy.sh}/$TOPIC" >/dev/null 2>&1 || exit 1
exit 0
