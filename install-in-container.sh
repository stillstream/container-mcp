#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/container-mcp
[[ -d "$ROOT" && "$PWD" == "$ROOT" ]] || { echo 'run inside the target container from /opt/container-mcp' >&2; exit 2; }
[[ "$(id -u)" == 0 ]] || { echo 'installer requires container root (uid 0)' >&2; exit 2; }
command -v node >/dev/null && command -v npm >/dev/null || { echo 'Node.js and npm are required inside this container' >&2; exit 2; }
node -e 'const v=process.versions.node.split(".").map(Number); if(v[0]<22 || (v[0]===22 && v[1]<19)) process.exit(1)' || { echo 'Node.js >=22.19 is required' >&2; exit 2; }
mkdir -p -m 700 "$ROOT/runtime"
chmod 600 "$ROOT/package.json"
npm ci --omit=dev --no-audit --no-fund
"$ROOT/container-mcp.sh" up
echo 'Container MCP installed and started locally; start tunnel-client separately after configuring it.'
