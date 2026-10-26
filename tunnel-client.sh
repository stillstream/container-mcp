#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/container-mcp; STATE=$ROOT/runtime; KEY_FILE=$STATE/control-plane-api-key; ID_FILE=$STATE/tunnel-id; TOKEN_FILE=$STATE/access-token
CLIENT=/usr/local/bin/tunnel-client-runtime-cloudflared; PID_FILE=$STATE/tunnel-client.pid; LOG_FILE=/var/log/container-mcp/tunnel-client.log
MCP_URL=http://127.0.0.1:18878/mcp; HEALTH_ADDR=127.0.0.1:38434
mkdir -p "$STATE" /var/log/container-mcp; chmod 700 "$STATE" /var/log/container-mcp
read_pid() { test -s "$PID_FILE" && tr -dc '0-9' < "$PID_FILE" || true; }
is_ours() { test -r "/proc/$1/cmdline" && tr '\0' ' ' < "/proc/$1/cmdline" | grep -F "$MCP_URL" | grep -Fq "$CLIENT"; }
case "$1" in
 set-api-key)
  test "$(id -u)" = 0 || exit 2
  IFS= read -r -s key || true; echo
  test -n "$key" || { echo 'empty API key' >&2; exit 2; }
  (umask 077; printf %s "$key" > "$KEY_FILE"); unset key; chmod 600 "$KEY_FILE"
  echo 'API key saved to container-only mode-600 file; restart tunnel-client to apply.' ;;
 set-tunnel-id)
  id="$2"; [[ "$id" =~ ^tunnel_[A-Za-z0-9_-]+$ ]] || { echo 'usage: set-tunnel-id tunnel_<id>' >&2; exit 2; }
  (umask 077; printf %s "$id" > "$ID_FILE"); chmod 600 "$ID_FILE"; echo 'Tunnel ID saved inside container.' ;;
 up)
  test -x "$CLIENT" || { echo "official tunnel-client missing at $CLIENT" >&2; exit 2; }
  test -s "$KEY_FILE" -a -s "$ID_FILE" -a -s "$TOKEN_FILE" || { echo 'configure credentials and start container-mcp first' >&2; exit 2; }
  curl -fsS --max-time 3 http://127.0.0.1:18878/healthz >/dev/null || { echo 'container-mcp is not healthy' >&2; exit 2; }
  pid="$(read_pid)"; if test -n "$pid" && kill -0 "$pid" 2>/dev/null && is_ours "$pid"; then echo "already running pid=$pid"; exit 0; fi
  tunnel_id="$(cat "$ID_FILE")"; token="$(cat "$TOKEN_FILE")"; umask 077
  nohup env CONTAINER_MCP_AUTH_HEADER="Bearer $token" "$CLIENT" run --control-plane.tunnel-id "$tunnel_id" --control-plane.api-key "file:$KEY_FILE" --mcp.server-url "url=$MCP_URL" --mcp.extra-headers 'Authorization: env:CONTAINER_MCP_AUTH_HEADER' --mcp.discovery-extra-headers 'Authorization: env:CONTAINER_MCP_AUTH_HEADER' --health.listen-addr "$HEALTH_ADDR" --log.level info >>"$LOG_FILE" 2>&1 </dev/null &
  pid=$!; echo "$pid" > "$PID_FILE"; chmod 600 "$PID_FILE"; unset token tunnel_id
  for n in $(seq 1 100); do if curl -fsS --max-time 1 "http://$HEALTH_ADDR/readyz" >/dev/null 2>&1; then echo "tunnel-client ready at $HEALTH_ADDR"; exit 0; fi; kill -0 "$pid" 2>/dev/null || break; sleep .2; done
  echo 'tunnel-client readiness failed; inspect logs (credentials are not printed)' >&2; exit 1 ;;
 down)
  pid="$(read_pid)"; test -n "$pid" || { echo stopped; exit 0; }; kill -0 "$pid" 2>/dev/null || { rm -f "$PID_FILE"; echo stopped; exit 0; }
  is_ours "$pid" || { echo 'refusing to stop unrelated process' >&2; exit 1; }; kill -TERM "$pid"; for n in $(seq 1 80); do kill -0 "$pid" 2>/dev/null || break; sleep .1; done; kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" || true; rm -f "$PID_FILE"; echo 'tunnel-client stopped' ;;
 status)
  pid="$(read_pid)"; test -n "$pid" && kill -0 "$pid" 2>/dev/null && is_ours "$pid" || { echo stopped; exit 1; }; curl -fsS --max-time 2 "http://$HEALTH_ADDR/healthz" ;;
 logs) tail -n 100 -f "$LOG_FILE" ;;
 *) echo 'Usage: tunnel-client.sh {set-api-key|set-tunnel-id tunnel_ID|up|down|status|logs}' >&2; exit 2 ;;
esac
