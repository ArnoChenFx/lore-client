#!/usr/bin/env bash
# Runs the ignored live tests in src-tauri/src/lore_adapter/live_server_tests.rs against the running
# stack. They run serially because login state and the Lore runtime are process-wide. Output is not
# captured, so the evidence lines each test prints (timings, counts, file paths) reach the log.
#
# Usage: scripts/e2e/run-live-tests.sh [test-name-filter]   (default filter: live_)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

e2e_check_home
e2e_require cargo
[ -f "$E2E_HOME/tls/trust-bundle.pem" ] || e2e_die "run scripts/e2e/setup-stack.sh first"

filter="${1:-live_}"
export LORE_E2E_SERVER="lore://$E2E_HOST:$E2E_SERVER_PORT"
export LORE_E2E_WORK_DIR="${LORE_E2E_WORK_DIR:-$E2E_HOME/work/run-$(date +%Y%m%d-%H%M%S)}"
export LORE_E2E_SHIM_DIR="$E2E_HOME/bin"
export SSL_CERT_FILE="$E2E_HOME/tls/trust-bundle.pem"
mkdir -p "$LORE_E2E_WORK_DIR"

cd "$E2E_REPO_ROOT"
cargo test --manifest-path src-tauri/Cargo.toml --lib "$filter" -- --ignored --test-threads=1 --nocapture
