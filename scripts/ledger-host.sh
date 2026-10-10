#!/usr/bin/env bash
#
# Resilix — hosted dev ledger (Daml 3.x, JSON Ledger API v2).
#
# This is the container entrypoint for the *public* ledger the deployed site
# talks to. It runs the same bring-up as scripts/localnet.sh (build-time DAR,
# a Canton sandbox serving JSON Ledger API v2, daml/Init.daml allocating the
# demo parties) and adds two things a public deployment needs:
#
#   1. it never exits — a supervisor loop restarts the sandbox if bring-up
#      fails, because a dead ledger is a dead website.
#   2. it RESETS on a timer (RESET_SECONDS, default 30 min). The reference
#      action is one-shot: once an application has executed, its AuditRecord
#      exists forever and the console correctly shows it as executed. For a
#      ledger shared by every visitor, that would mean the first person to
#      click Execute ends the demo for everyone. A periodic re-init gives each
#      visitor the whole flow from a clean slate.
#
# A reset re-allocates every party under a NEW namespace (the namespace is the
# participant's signing-key fingerprint, and a restarted sandbox generates a new
# key). That is why app/api/ledger/route.ts resolves slugs from /v2/parties at
# request time instead of from LEDGER_PARTY_MAP baked into the environment: a
# static map would point at parties that no longer exist after the first reset.
#
# Two hard-won facts about the sandbox's sockets are encoded below.
#
#   1. It binds a BLOCK of gRPC ports, not one. `--port` is the Ledger API, and
#      the admin, sequencer-public, sequencer-admin and mediator-admin APIs are
#      separate listeners. Left unset, some of them come from FIXED defaults —
#      the sequencer admin API asked for 6868 even when `--port` was 6880 — so
#      moving `--port` does not move them out of the way. They are therefore all
#      passed explicitly. This is not hypothetical: a hosted ledger on 6866
#      overlapped a LocalNet on 6865, and the resulting bind failure is
#      indistinguishable from a slow start.
#   2. The JSON API binds loopback unless told otherwise, which makes a hosted
#      deployment unreachable. scripts/canton-hosted.conf sets the address; see
#      that file for the measurement.
#
# Unlike scripts/localnet.sh this does NOT redirect the sandbox's output — here
# stdout IS the platform log, so the ledger's own lines must reach it.
#
# Env:
#   PORT            JSON Ledger API port to bind on 0.0.0.0 (platform-provided;
#                   default 7575)
#   GRPC_PORT       Base for the sandbox's five gRPC ports, loopback only
#                   (default 6965; the block runs GRPC_PORT .. GRPC_PORT+4)
#   RESET_SECONDS   Reset interval; 0 disables the timer (default 1800)

set -uo pipefail

PORT="${PORT:-7575}"
GRPC_PORT="${GRPC_PORT:-6965}"
RESET_SECONDS="${RESET_SECONDS:-1800}"

# Memory discipline for a small container.
#
# A hosted platform caps the container well below the host (here ~950MB) but
# still shows the JVM the HOST's CPU count and, through /proc/meminfo, the host's
# RAM. Left alone the sandbox JVM sizes its heap against hundreds of GB and sizes
# its thread pools to all 48 host cores — and when the Init script spins up a
# SECOND JVM to connect, the pair is SIGKILLed (ExitFailure -9) long before any
# Java-level OOM. Measured: the first run died exactly as the script client
# attached, with /livez still green.
#
# So both JVMs are told the truth. UseContainerSupport makes MaxRAMPercentage
# read the cgroup limit rather than /proc/meminfo, and ActiveProcessorCount caps
# the thread pools. The sandbox is the long-lived, heap-hungry one; the script
# client is transient and gets a hard, tiny ceiling so the two fit side by side
# during Init (and during every reset, which repeats the overlap).
#   JVM_HEAP_PCT    sandbox max heap as % of the cgroup limit (default 55)
#   JVM_CPUS        processors each JVM may assume (default 2)
#   SCRIPT_HEAP     hard -Xmx for the transient Init client (default 192m)
JVM_HEAP_PCT="${JVM_HEAP_PCT:-55}"
JVM_CPUS="${JVM_CPUS:-2}"
SCRIPT_HEAP="${SCRIPT_HEAP:-192m}"
export _JAVA_OPTIONS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=${JVM_HEAP_PCT} -XX:ActiveProcessorCount=${JVM_CPUS}"

# The private gRPC block. Kept clear of 6865-6869 so a hosted ledger and a
# LocalNet can run on the same machine during development.
ADMIN_PORT=$((GRPC_PORT + 1))
SEQUENCER_PUBLIC_PORT=$((GRPC_PORT + 2))
SEQUENCER_ADMIN_PORT=$((GRPC_PORT + 3))
MEDIATOR_ADMIN_PORT=$((GRPC_PORT + 4))

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAML_DIR="$ROOT/daml"
DAR="$DAML_DIR/.daml/dist/resilix-0.1.0.dar"
CONF="$ROOT/scripts/canton-hosted.conf"
JSON_URL="http://localhost:$PORT"

export PATH="$HOME/.daml/bin:$PATH"

# The container image provides JAVA_HOME; a dev machine may have the JDK under
# ~/.local/jdk instead (same discovery as scripts/localnet.sh), so a local test
# run of this script behaves like the deployed one.
if [ -z "${JAVA_HOME:-}" ]; then
  CAND="$(ls -d "$HOME"/.local/jdk/*/ 2>/dev/null | head -1 || true)"
  if [ -n "$CAND" ]; then
    export JAVA_HOME="${CAND%/}"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
fi

sandbox_pid=""

log() { echo "[ledger-host] $*"; }

stop_sandbox() {
  if [ -n "$sandbox_pid" ] && kill -0 "$sandbox_pid" 2>/dev/null; then
    # Negative pid kills the whole process group: `daml` is a launcher that
    # hands off to a JVM, and killing only the launcher would orphan the sandbox.
    kill -- -"$sandbox_pid" 2>/dev/null || kill "$sandbox_pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$sandbox_pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 -- -"$sandbox_pid" 2>/dev/null || true
  fi
  sandbox_pid=""
}

wait_for_http() {
  for _ in $(seq 1 150); do
    curl -sf --max-time 3 "$JSON_URL/livez" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# True if something is already accepting connections on this port. bash's
# /dev/tcp needs no external tool, which matters here: ss(8) and lsof(8) are not
# guaranteed in the image.
port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# A sandbox left over from the previous cycle holds the whole port block, and a
# new one started on top of it dies with a bind error — while every readiness
# check below passes against the OLD ledger. That would mean a reset that does
# not reset: the site would keep serving the previous cycle's contracts,
# approvals and audit records. So the ports must actually be free before
# bring-up is allowed to proceed.
wait_for_ports_free() {
  for _ in $(seq 1 60); do
    local busy=0
    for p in "$GRPC_PORT" "$ADMIN_PORT" "$SEQUENCER_PUBLIC_PORT" "$SEQUENCER_ADMIN_PORT" "$MEDIATOR_ADMIN_PORT" "$PORT"; do
      port_busy "$p" && busy=1
    done
    [ "$busy" = 0 ] && return 0
    sleep 1
  done
  return 1
}

# /livez only proves the HTTP server is listening. In 3.x the participant and the
# synchronizer start as separate components and connect asynchronously, so party
# allocation still fails with PARTY_ALLOCATION_WITHOUT_CONNECTED_SYNCHRONIZER for
# a while after /livez goes green. This gate is what makes Init safe to run.
wait_for_synchronizer() {
  for _ in $(seq 1 90); do
    curl -sf --max-time 3 "$JSON_URL/v2/state/connected-synchronizers" 2>/dev/null \
      | grep -q '"synchronizerId"' && return 0
    sleep 2
  done
  return 1
}

bring_up() {
  if ! wait_for_ports_free; then
    log "ERROR: a previous sandbox still holds the port block — refusing to start on top of it"
    return 1
  fi

  log "starting sandbox (gRPC block :$GRPC_PORT-$MEDIATOR_ADMIN_PORT, JSON Ledger API v2 :$PORT on 0.0.0.0)"
  ( cd "$DAML_DIR" && exec setsid daml sandbox \
      -c "$CONF" \
      --port "$GRPC_PORT" \
      --admin-api-port "$ADMIN_PORT" \
      --sequencer-public-port "$SEQUENCER_PUBLIC_PORT" \
      --sequencer-admin-port "$SEQUENCER_ADMIN_PORT" \
      --mediator-admin-port "$MEDIATOR_ADMIN_PORT" \
      --json-api-port "$PORT" --dar "$DAR" ) &
  sandbox_pid=$!

  wait_for_http || { log "ERROR: /livez never came up"; return 1; }
  log "JSON Ledger API is answering"
  wait_for_synchronizer || { log "ERROR: the participant never joined a synchronizer"; return 1; }
  log "participant connected to the synchronizer"

  log "allocating parties + creating policies (Init:initialize)"
  # 127.0.0.1 rather than "localhost": the sandbox binds an IPv4 socket
  # ([::ffff:127.0.0.1]), and in the container "localhost" also resolves to ::1,
  # which that socket does not accept. The script client then fails to connect
  # and Init dies — while the JSON API above is perfectly healthy, which makes
  # it look like a readiness problem rather than a name-resolution one.
  #
  # SCRIPT_HEAP overrides the percentage-based cap with a hard, tiny ceiling:
  # this JVM is transient and only has to drive one script, so it must not claim
  # a percentage of the container the long-lived sandbox is already holding.
  ( cd "$DAML_DIR" && _JAVA_OPTIONS="-XX:+UseContainerSupport -Xmx${SCRIPT_HEAP} -XX:ActiveProcessorCount=${JVM_CPUS}" \
      daml script --dar "$DAR" --script-name Init:initialize \
      --ledger-host 127.0.0.1 --ledger-port "$GRPC_PORT" ) \
    || { log "ERROR: Init:initialize failed"; return 1; }

  log "ledger ready — parties allocated, policies and hosting groups live"
  return 0
}

if [ ! -f "$DAR" ]; then
  log "ERROR: $DAR is missing — the image build must run 'daml build'"
  exit 1
fi

# Without the config the sandbox comes up perfectly and is simply unreachable
# from outside the container, which is the worst kind of failure to debug from a
# platform log. Fail loudly at boot instead.
if [ ! -f "$CONF" ]; then
  log "ERROR: $CONF is missing — the JSON API would bind loopback only"
  exit 1
fi

log "resilix hosted dev ledger · reset every ${RESET_SECONDS}s"
[ "$RESET_SECONDS" = "0" ] && log "note: RESET_SECONDS=0 — state is never reset"

while true; do
  if bring_up; then
    if [ "$RESET_SECONDS" = "0" ]; then
      # No timer: hold the sandbox up until it dies.
      wait "$sandbox_pid"
      log "sandbox exited — restarting"
    else
      log "next reset in ${RESET_SECONDS}s"
      sleep "$RESET_SECONDS"
      log "scheduled reset — bringing up a clean ledger"
    fi
  else
    log "bring-up failed — retrying in 15s"
    sleep 15
  fi
  stop_sandbox
  sleep 2
done
