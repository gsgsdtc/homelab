#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DEPLOY="${SCRIPT_DIR}/ops-deploy.sh"

if [ ! -x "${OPS_DEPLOY}" ]; then
  echo "Missing executable deploy implementation: ${OPS_DEPLOY}" >&2
  exit 1
fi

exec "${OPS_DEPLOY}" "$@"
