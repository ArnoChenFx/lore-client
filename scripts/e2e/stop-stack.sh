#!/usr/bin/env bash
# Stops the processes started by start-stack.sh. Sends SIGTERM and falls back to SIGKILL after 20 seconds.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for name in server auth; do
  pidfile="$E2E_HOME/run/$name.pid"
  if [ ! -f "$pidfile" ]; then
    e2e_log "$name: not started by this stack"
    continue
  fi
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
      e2e_log "$name (pid $pid) did not stop after SIGTERM; killed"
    else
      e2e_log "$name (pid $pid) stopped"
    fi
  else
    e2e_log "$name (pid $pid) was not running"
  fi
  rm -f "$pidfile"
done
