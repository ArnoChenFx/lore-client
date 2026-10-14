#!/usr/bin/env bash
# Starts lore-auth-service and loreserver for the local E2E stack, waits until both answer, and
# creates the test users. Processes run detached from this shell; stop them with stop-stack.sh.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

e2e_check_home
[ -f "$E2E_HOME/auth/auth.env" ] && [ -x "$E2E_HOME/bin/loreserver" ] || e2e_die "run scripts/e2e/setup-stack.sh first"
e2e_require curl python3
bun_bin="$(e2e_bun)"

is_running() {
  local pidfile="$E2E_HOME/run/$1.pid"
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

if is_running auth; then
  e2e_log "lore-auth-service already running (pid $(cat "$E2E_HOME/run/auth.pid"))"
else
  e2e_log "starting lore-auth-service on $E2E_HOST:$E2E_AUTH_PORT (gRPC $E2E_AUTH_GRPC_PORT)"
  (
    set -a
    . "$E2E_HOME/auth/auth.env"
    set +a
    cd "$E2E_AUTH_DIR"
    exec nohup "$bun_bin" run src/index.ts
  ) >"$E2E_HOME/logs/auth.log" 2>&1 </dev/null &
  echo $! >"$E2E_HOME/run/auth.pid"
fi
e2e_wait_https "https://$E2E_HOST:$E2E_AUTH_PORT/health_check" 90 "lore-auth-service"
e2e_wait_tcp "$E2E_HOST" "$E2E_AUTH_GRPC_PORT" 30 "lore-auth-service gRPC"

if is_running server; then
  e2e_log "loreserver already running (pid $(cat "$E2E_HOME/run/server.pid"))"
else
  e2e_log "starting loreserver on $E2E_HOST:$E2E_SERVER_PORT (TCP gRPC and UDP QUIC)"
  (
    export LORE_CONFIG_PATH="$E2E_HOME/server/config" LORE_ENV=stack RUST_LOG="${RUST_LOG:-info}"
    export SSL_CERT_FILE="$E2E_HOME/tls/trust-bundle.pem"
    exec nohup "$E2E_HOME/bin/loreserver"
  ) >"$E2E_HOME/logs/server.log" 2>&1 </dev/null &
  echo $! >"$E2E_HOME/run/server.pid"
fi
e2e_wait_tcp "$E2E_HOST" "$E2E_SERVER_PORT" 60 "loreserver"

python3 "$E2E_SCRIPT_DIR/seed-users.py"

e2e_log "stack is up: lore://$E2E_HOST:$E2E_SERVER_PORT, https://$E2E_HOST:$E2E_AUTH_PORT"
