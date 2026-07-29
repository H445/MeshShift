#!/usr/bin/env sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "ModelShift requires Node.js 20 or newer." >&2
  exit 1
fi

exec node "$PROJECT_ROOT/scripts/dev.mjs" "$@"
