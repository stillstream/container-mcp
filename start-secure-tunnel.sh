#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/container-mcp
[[ -d "$ROOT" && "$PWD" == "$ROOT" ]] || { echo 'tunnel management must run inside the target container from /opt/container-mcp' >&2; exit 2; }
exec "$ROOT/tunnel-client.sh" "$@"
