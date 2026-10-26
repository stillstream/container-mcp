#!/usr/bin/env bash
set -euo pipefail

ROOT="/opt/container-mcp"
PID_FILE="/var/run/container-mcp/server.pid"
LOG_FILE="/var/log/container-mcp/server.log"
HOST="127.0.0.1"
PORT="18878"
URL="http://${HOST}:${PORT}"

mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
chmod 700 "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
read_pid() { [[ -s "$PID_FILE" ]] && tr -dc '0-9' < "$PID_FILE" || true; }
port_free() {
  node -e 'const net=require("node:net");const s=net.createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close(()=>process.exit(0)))' "$PORT"
}
is_our_server() {
  local pid="$1" cmd
  [[ -r "/proc/${pid}/cmdline" ]] || return 1
  cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
  [[ "$cmd" == *"${ROOT}/src/server.mjs"* ]]
}

case "${1:-}" in
  up|start)
    [[ "$(id -u)" == "0" ]] || { echo 'container-mcp must run as container root (uid 0)' >&2; exit 2; }
    [[ -x "$(command -v node || true)" ]] || { echo 'node is required' >&2; exit 2; }
    [[ -f "$ROOT/src/server.mjs" && -f "$ROOT/node_modules/@modelcontextprotocol/sdk/package.json" ]] || {
      echo "service files/dependencies missing under ${ROOT}; run install-in-container.sh" >&2; exit 2;
    }
    old_pid="$(read_pid)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null && is_our_server "$old_pid"; then
      if curl --fail --silent --max-time 2 "${URL}/healthz" >/dev/null; then echo "already up (pid ${old_pid}, ${URL}/mcp)"; exit 0; fi
    fi
    if ! port_free; then
      echo "${HOST}:${PORT} is occupied by another process; refusing to start" >&2; exit 1
    fi
    umask 077
    nohup env CONTAINER_MCP_HOST="$HOST" CONTAINER_MCP_PORT="$PORT" \
      CONTAINER_MCP_TOKEN_FILE="${ROOT}/runtime/access-token" \
      node "${ROOT}/src/server.mjs" >>"$LOG_FILE" 2>&1 </dev/null &
    pid=$!
    printf '%s\n' "$pid" >"$PID_FILE"
    chmod 600 "$PID_FILE"
    ready=0
    for _ in $(seq 1 100); do
      if curl --fail --silent --max-time 1 "${URL}/healthz" >/dev/null 2>&1; then ready=1; break; fi
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if [[ "$ready" != 1 ]]; then
      echo 'container-mcp failed readiness check; inspect logs' >&2
      if is_our_server "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi
      rm -f "$PID_FILE"
      exit 1
    fi
    echo "started pid=${pid} uid=0 listen=${URL}/mcp (loopback only)"
    ;;
  down|stop)
    pid="$(read_pid)"
    if [[ -z "$pid" ]]; then echo 'not running (no pid file)'; exit 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then rm -f "$PID_FILE"; echo 'stale pid file removed'; exit 0; fi
    is_our_server "$pid" || { echo "refusing to stop unrelated pid ${pid}" >&2; exit 1; }
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 80); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      is_our_server "$pid" || { echo 'pid ownership changed; refusing SIGKILL' >&2; exit 1; }
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo 'stopped container-mcp'
    ;;
  status)
    pid="$(read_pid)"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null || ! is_our_server "$pid"; then
      echo 'stopped'
      exit 1
    fi
    curl --fail --silent --show-error --max-time 2 "${URL}/healthz"
    ;;
  logs)
    if [[ "${2:-}" == '-f' || "${2:-}" == '--follow' ]]; then tail -n 100 -f "$LOG_FILE"; else tail -n 100 "$LOG_FILE"; fi
    ;;
  smoke)
    [[ -f "$ROOT/runtime/access-token" ]] || { echo 'access token not initialized; start service first' >&2; exit 2; }
    cd "$ROOT"
    node test/smoke.mjs
    ;;
  *)
    echo "Usage: $0 {up|down|status|logs [-f]|smoke}" >&2
    exit 2
    ;;
esac
