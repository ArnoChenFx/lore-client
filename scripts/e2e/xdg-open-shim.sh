#!/usr/bin/env bash
# Local E2E stand-in for the desktop browser. Lore Client opens the auth-service login page through
# xdg-open; this shim reads session_code and client_state from that URL and approves the session as the
# configured test user, the same as typing the credentials into the login page.
#
# Installed as $LORE_E2E_HOME/bin/xdg-open by setup-stack.sh. Environment overrides:
#   LORE_E2E_LOGIN_USER      test user to sign in as (default alice)
#   LORE_E2E_LOGIN_PASSWORD  password to submit (default: from auth/users.env)
#   LORE_E2E_SHIM_DISABLE    when set, log the request and do not approve it
#   LORE_E2E_SHIM_LOG        log file (default: $LORE_E2E_HOME/logs/xdg-open-shim.log)
# The log records the login page path only, never the session codes or passwords.
set -u

e2e_home="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="${LORE_E2E_SHIM_LOG:-$e2e_home/logs/xdg-open-shim.log}"
mkdir -p "$(dirname "$log")"
url="${1:-}"

note() {
  printf '%s %s\n' "$(date -Is)" "$1" >>"$log"
}

note "xdg-open ${url%%\?*}"

if [ -n "${LORE_E2E_SHIM_DISABLE:-}" ]; then
  note "shim disabled, not approving"
  exit 0
fi

parsed="$(python3 -c '
import sys, urllib.parse
parts = urllib.parse.urlsplit(sys.argv[1])
query = dict(urllib.parse.parse_qsl(parts.query))
print(f"{parts.scheme}://{parts.netloc}")
print(query.get("session_code", ""))
print(query.get("client_state", ""))
' "$url")" || { note "could not parse the login URL"; exit 1; }
{ IFS= read -r origin; IFS= read -r session_code; IFS= read -r client_state; } <<<"$parsed"
if [ -z "$session_code" ] || [ -z "$client_state" ]; then
  note "login URL has no session_code or client_state"
  exit 1
fi

user="${LORE_E2E_LOGIN_USER:-alice}"
password="${LORE_E2E_LOGIN_PASSWORD:-}"
if [ -z "$password" ]; then
  [ -f "$e2e_home/auth/users.env" ] || { note "no auth/users.env for $user"; exit 1; }
  set -a
  # shellcheck disable=SC1091
  . "$e2e_home/auth/users.env"
  set +a
  password_variable="E2E_$(printf '%s' "$user" | tr '[:lower:]' '[:upper:]')_PASSWORD"
  password="${!password_variable:-}"
fi
if [ -z "$password" ]; then
  note "no password configured for $user"
  exit 1
fi

status="$(LORE_SHIM_PASSWORD="$password" LORE_SHIM_CA="${LORE_E2E_CA_FILE:-$e2e_home/tls/ca.pem}" python3 -c '
import os, ssl, sys, urllib.error, urllib.parse, urllib.request
origin, code, state, user = sys.argv[1:5]
context = ssl.create_default_context(cafile=os.environ["LORE_SHIM_CA"])
body = urllib.parse.urlencode({
    "session_code": code,
    "client_state": state,
    "username": user,
    "password": os.environ["LORE_SHIM_PASSWORD"],
}).encode("utf-8")
request = urllib.request.Request(
    origin + "/auth/session/approve",
    data=body,
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    method="POST",
)
try:
    with urllib.request.urlopen(request, context=context, timeout=20) as response:
        print(response.status)
except urllib.error.HTTPError as error:
    print(error.code)
' "$origin" "$session_code" "$client_state" "$user" 2>>"$log")"

note "approve user=$user http=$status"
[ "$status" = "200" ]
