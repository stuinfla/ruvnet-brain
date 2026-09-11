#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'TriSmart Skill needs Node.js 18 or newer. Install it from https://nodejs.org/ and run this file again.'
  printf '%s\n' 'Press Return to close.'
  read -r _
  exit 2
fi
case " $* " in *" --project="*|*" --project "*) ;; *) set -- "$@" "--project=$HOME" ;; esac
node "$SCRIPT_DIR/install.mjs" "$@"
printf '%s\n' 'TriSmart setup finished. Press Return to close.'
read -r _
