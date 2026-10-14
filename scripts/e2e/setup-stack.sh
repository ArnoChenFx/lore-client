#!/usr/bin/env bash
# Prepares the local Lore E2E stack under $LORE_E2E_HOME (default ~/lore-e2e): the local CA and
# server certificate, the lore-auth-service checkout, the loreserver binary, configuration files,
# test credentials and the xdg-open stand-in. Re-running keeps existing keys, passwords and databases.
#
# Usage: scripts/e2e/setup-stack.sh
# Set LORESERVER_BIN=/path/to/loreserver to use a local binary instead of pulling the GHCR image.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,8p' "$0"
  exit 0
fi

e2e_check_home
e2e_require git openssl curl python3 sed install
bun_bin="$(e2e_bun)"
[ -f "$E2E_SYSTEM_CA_BUNDLE" ] || e2e_die "system CA bundle not found: $E2E_SYSTEM_CA_BUNDLE (set LORE_E2E_SYSTEM_CA_BUNDLE)"

tls="$E2E_HOME/tls"
auth="$E2E_HOME/auth"
umask 077
mkdir -p "$E2E_HOME/bin" "$E2E_HOME/server/config" "$E2E_HOME/server/data" "$E2E_HOME/src" \
  "$E2E_HOME/logs" "$E2E_HOME/work" "$E2E_HOME/run" "$tls" "$auth"
chmod 700 "$tls" "$auth"
# Auth state written by an earlier run (database, signing keys) may predate the private umask.
find "$auth" -mindepth 1 -maxdepth 2 -exec chmod go-rwx {} +

# Keeps KEY from FILE when it already exists so re-running setup never rotates passwords.
existing_or_new_secret() {
  local file="$1" key="$2" value=""
  if [ -f "$file" ]; then
    value="$(sed -n "s/^${key}=//p" "$file" | head -n 1)"
  fi
  printf '%s\n' "${value:-$(openssl rand -hex 24)}"
}

if [ ! -f "$tls/ca.pem" ]; then
  e2e_log "creating the local certificate authority"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=Lore E2E Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$tls/ca-key.pem" -out "$tls/ca.pem" 2>/dev/null
fi

if [ ! -f "$tls/server.pem" ]; then
  e2e_log "creating the server certificate for $E2E_HOST"
  san="IP:127.0.0.1,DNS:localhost"
  if [ "$E2E_HOST" != "127.0.0.1" ]; then
    case "$E2E_HOST" in
      *[!0-9.]*) san="$san,DNS:$E2E_HOST" ;;
      *) san="$san,IP:$E2E_HOST" ;;
    esac
  fi
  printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$san" > "$tls/server.ext"
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$E2E_HOST" \
    -keyout "$tls/server-key.pem" -out "$tls/server.csr" 2>/dev/null
  openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.pem" -CAkey "$tls/ca-key.pem" -CAcreateserial \
    -days 825 -sha256 -extfile "$tls/server.ext" -out "$tls/server.pem" 2>/dev/null
  rm -f "$tls/server.csr" "$tls/server.ext"
fi
cat "$tls/server.pem" "$tls/ca.pem" > "$tls/fullchain.pem"
# rustls-native-certs reads SSL_CERT_FILE *instead of* the system store, so the bundle carries both.
cat "$E2E_SYSTEM_CA_BUNDLE" "$tls/ca.pem" > "$tls/trust-bundle.pem"

if [ ! -d "$E2E_AUTH_DIR/.git" ]; then
  e2e_log "cloning lore-auth-service into $E2E_AUTH_DIR"
  git clone --quiet "$E2E_AUTH_REPO" "$E2E_AUTH_DIR"
fi
if ! git -C "$E2E_AUTH_DIR" cat-file -e "$E2E_AUTH_REF^{commit}" 2>/dev/null; then
  git -C "$E2E_AUTH_DIR" fetch --quiet origin
fi
git -C "$E2E_AUTH_DIR" -c advice.detachedHead=false checkout --quiet "$E2E_AUTH_REF"
e2e_log "installing lore-auth-service dependencies at $(git -C "$E2E_AUTH_DIR" rev-parse --short HEAD)"
(cd "$E2E_AUTH_DIR" && "$bun_bin" install --frozen-lockfile >/dev/null)

if [ -n "${LORESERVER_BIN:-}" ]; then
  e2e_log "copying loreserver from LORESERVER_BIN"
  install -m 0755 "$LORESERVER_BIN" "$E2E_HOME/bin/loreserver"
elif [ ! -x "$E2E_HOME/bin/loreserver" ]; then
  e2e_log "extracting loreserver from $E2E_SERVER_IMAGE:$E2E_SERVER_TAG"
  pin_args=()
  if [ -n "$E2E_SERVER_DIGEST" ]; then
    pin_args=(--expect-digest "$E2E_SERVER_DIGEST")
  fi
  python3 "$E2E_SCRIPT_DIR/fetch-loreserver.py" --image "$E2E_SERVER_IMAGE" --tag "$E2E_SERVER_TAG" \
    "${pin_args[@]}" --out "$E2E_HOME/bin/loreserver"
fi
e2e_log "loreserver sha256: $(sha256sum "$E2E_HOME/bin/loreserver" | cut -d' ' -f1)"

admin_password="$(existing_or_new_secret "$auth/auth.env" ADMIN_PASSWORD)"
alice_password="$(existing_or_new_secret "$auth/users.env" E2E_ALICE_PASSWORD)"
bob_password="$(existing_or_new_secret "$auth/users.env" E2E_BOB_PASSWORD)"

cat > "$auth/auth.env" <<EOF
HOST=$E2E_HOST
PORT=$E2E_AUTH_PORT
GRPC_HOST=$E2E_HOST
GRPC_PORT=$E2E_AUTH_GRPC_PORT
PUBLIC_BASE_URL=https://$E2E_HOST:$E2E_AUTH_PORT
JWT_ISSUER=https://$E2E_HOST:$E2E_AUTH_PORT
JWT_AUDIENCE=$E2E_HOST
LORE_ENVIRONMENT=local
TLS_CERT_FILE=$tls/fullchain.pem
TLS_KEY_FILE=$tls/server-key.pem
NODE_EXTRA_CA_CERTS=$tls/ca.pem
KEY_DIR=$auth/keys
DB_PATH=$auth/lore-auth.db
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$admin_password
AUTH_SESSION_TTL=300
EOF

cat > "$auth/users.env" <<EOF
E2E_ALICE_USER=alice
E2E_ALICE_PASSWORD=$alice_password
E2E_BOB_USER=bob
E2E_BOB_PASSWORD=$bob_password
EOF

cat > "$E2E_HOME/server/config/stack.toml" <<EOF
[server.grpc]
host = "$E2E_HOST"
port = $E2E_SERVER_PORT

[server.quic]
host = "$E2E_HOST"
port = $E2E_SERVER_PORT

[server.quic.certificate]
cert_file = "$tls/fullchain.pem"
pkey_file = "$tls/server-key.pem"

[server.http]
host = "$E2E_HOST"
port = $E2E_SERVER_HTTP_PORT

[environment.endpoint]
auth_url = "https://$E2E_HOST:$E2E_AUTH_GRPC_PORT"

[server.auth]
jwt_issuer = "https://$E2E_HOST:$E2E_AUTH_PORT"
jwt_audience = ["$E2E_HOST"]

[server.auth.jwk]
endpoint = "https://$E2E_HOST:$E2E_AUTH_PORT/.well-known/jwks.json"

[immutable_store.local]
path = "$E2E_HOME/server/data"

[mutable_store.local]
path = "$E2E_HOME/server/data"
EOF

install -m 0755 "$E2E_SCRIPT_DIR/xdg-open-shim.sh" "$E2E_HOME/bin/xdg-open"

e2e_log "setup complete in $E2E_HOME"
e2e_log "next: scripts/e2e/start-stack.sh, then scripts/e2e/run-live-tests.sh"
