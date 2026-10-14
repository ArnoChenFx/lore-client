# Shared settings for the local Lore E2E stack. Sourced by the other scripts in this directory.
# Every value can be overridden from the environment; the defaults match docs/en/E2E_LOCAL_STACK.md.

E2E_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_REPO_ROOT="$(cd "$E2E_SCRIPT_DIR/../.." && pwd)"
E2E_HOME="${LORE_E2E_HOME:-$HOME/lore-e2e}"
E2E_HOST="${LORE_E2E_HOST:-127.0.0.1}"
E2E_SERVER_PORT="${LORE_E2E_SERVER_PORT:-41337}"
E2E_SERVER_HTTP_PORT="${LORE_E2E_SERVER_HTTP_PORT:-41339}"
E2E_AUTH_PORT="${LORE_E2E_AUTH_PORT:-8080}"
E2E_AUTH_GRPC_PORT="${LORE_E2E_AUTH_GRPC_PORT:-50051}"
E2E_AUTH_REPO="${LORE_AUTH_SERVICE_REPO:-https://github.com/ArnoChenFx/lore-auth-service.git}"
# b4be18d carries the fixes in ArnoChenFx/lore-auth-service#1. Move this to the merge commit once that PR lands.
E2E_AUTH_REF="${LORE_AUTH_SERVICE_REF:-b4be18d}"
E2E_AUTH_DIR="${LORE_AUTH_SERVICE_DIR:-$E2E_HOME/src/lore-auth-service}"
E2E_SERVER_IMAGE="${LORE_SERVER_IMAGE:-arnochenfx/lore-server}"
E2E_SERVER_TAG="${LORE_SERVER_TAG:-0.10.1}"
E2E_SERVER_DIGEST="${LORE_SERVER_DIGEST-sha256:6dad04dc1280cfb324ebb96fe0c683d6165774fe2b03197c0f634be3f09e02e4}"
E2E_SYSTEM_CA_BUNDLE="${LORE_E2E_SYSTEM_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"

export LORE_E2E_HOME="$E2E_HOME"

e2e_log() {
  printf '[e2e] %s\n' "$*"
}

e2e_die() {
  printf '[e2e] error: %s\n' "$*" >&2
  exit 1
}

e2e_check_home() {
  case "$E2E_HOME/" in
    "$E2E_REPO_ROOT"/*) e2e_die "LORE_E2E_HOME must be outside the repository so keys and passwords cannot be committed: $E2E_HOME" ;;
  esac
}

e2e_require() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || e2e_die "missing required tool: $tool"
  done
}

e2e_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
  elif [ -x "$HOME/.bun/bin/bun" ]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
  else
    e2e_die "bun 1.4 or newer is required to run lore-auth-service (https://bun.sh)"
  fi
}

# Waits until a TCP port accepts connections. Usage: e2e_wait_tcp HOST PORT TIMEOUT_SECONDS LABEL
e2e_wait_tcp() {
  local host="$1" port="$2" timeout="$3" label="$4" waited=0
  until (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -lt "$timeout" ] || e2e_die "$label did not open $host:$port within ${timeout}s; see the log in $E2E_HOME/logs"
    sleep 1
  done
  e2e_log "$label is listening on $host:$port"
}

# Waits for an HTTPS URL to return 200. Usage: e2e_wait_https URL TIMEOUT_SECONDS LABEL
e2e_wait_https() {
  local url="$1" timeout="$2" label="$3" waited=0
  until curl -fsS --max-time 5 --cacert "$E2E_HOME/tls/ca.pem" -o /dev/null "$url" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -lt "$timeout" ] || e2e_die "$label did not answer $url within ${timeout}s; see the log in $E2E_HOME/logs"
    sleep 1
  done
  e2e_log "$label answers at $url"
}
