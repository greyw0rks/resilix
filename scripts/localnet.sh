#!/usr/bin/env bash
#
# Canton Resilience — LocalNet bring-up (Daml 3.x, JSON Ledger API v2).
#
# Builds the DAR, starts a Canton sandbox that serves both the gRPC Ledger API
# and the HTTP JSON Ledger API v2 (no separate `daml json-api` process — that
# command was removed in Daml 3.x; the sandbox serves v2 itself), allocates the
# demo parties, creates the HostingGroups and one Policy per reference
# application, and writes .env.local so the Next.js app (via
# app/api/ledger/route.ts) talks to the live ledger.
#
# Prereqs: a JDK on PATH (or JAVA_HOME set) and the Daml SDK (`daml`) installed.
# The sandbox must be a 3.x SDK — the contracts target Daml-LF 2.1, which a 2.x
# participant cannot host, and JSON Ledger API v2 does not exist before 3.x.
# See docs/LOCALNET.md for the one-time toolchain install.
#
# Usage:  ./scripts/localnet.sh          # from the repo root
# Stop:   ./scripts/localnet.sh stop
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAML_DIR="$ROOT/daml"
DAR="$DAML_DIR/.daml/dist/canton-resilience-0.1.0.dar"
LEDGER_PORT=6865
JSON_PORT=7575
INIT_OUT="$ROOT/.localnet-init.json"
PIDS_FILE="$ROOT/.localnet-pids"
SANDBOX_LOG="$ROOT/.localnet-sandbox.log"

# Make a locally-installed JDK visible if JAVA_HOME is not already set.
if [ -z "${JAVA_HOME:-}" ]; then
  CAND="$(ls -d "$HOME"/.local/jdk/*/ 2>/dev/null | head -1 || true)"
  if [ -n "$CAND" ]; then export JAVA_HOME="${CAND%/}"; export PATH="$JAVA_HOME/bin:$PATH"; fi
fi
export PATH="$HOME/.daml/bin:$PATH"

stop() {
  echo "Stopping LocalNet..."
  [ -f "$PIDS_FILE" ] && while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$PIDS_FILE"
  rm -f "$PIDS_FILE"
  exit 0
}
[ "${1:-}" = "stop" ] && stop

command -v daml >/dev/null || { echo "ERROR: 'daml' not on PATH — see docs/LOCALNET.md"; exit 1; }
command -v java >/dev/null || { echo "ERROR: no JDK on PATH / JAVA_HOME unset"; exit 1; }

echo "==> daml build"
( cd "$DAML_DIR" && daml build )

echo "==> starting sandbox (gRPC :$LEDGER_PORT, JSON Ledger API v2 :$JSON_PORT)"
# The sandbox hosts the DAR directly and serves the JSON Ledger API v2 on
# --json-api-port. Readiness is checked below against /livez.
#
# Its output goes to its own log file rather than the console: the sandbox
# outlives this script, so an inherited stdout would keep any pipe (`| tail`)
# open forever and the bring-up would never appear to finish.
( cd "$DAML_DIR" && daml sandbox --port "$LEDGER_PORT" --json-api-port "$JSON_PORT" --dar "$DAR" ) \
  > "$SANDBOX_LOG" 2>&1 &
echo $! > "$PIDS_FILE"

echo "==> waiting for the JSON Ledger API..."
for _ in $(seq 1 90); do
  curl -sf --max-time 3 "http://localhost:$JSON_PORT/livez" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf --max-time 3 "http://localhost:$JSON_PORT/livez" >/dev/null 2>&1 \
  || { echo "ERROR: the ledger did not come up — see $SANDBOX_LOG"; tail -30 "$SANDBOX_LOG"; exit 1; }

echo "==> waiting for the participant to connect to the synchronizer..."
# /livez only proves the HTTP server is listening. In 3.x the sandbox starts the
# participant and the synchronizer as separate components and connects them
# asynchronously, so party allocation still fails — with
# PARTY_ALLOCATION_WITHOUT_CONNECTED_SYNCHRONIZER — for a while after /livez is
# green. This gate is what actually makes the Init script safe to run.
connected() {
  curl -sf --max-time 3 "http://localhost:$JSON_PORT/v2/state/connected-synchronizers" 2>/dev/null \
    | grep -q '"synchronizerId"'
}
for _ in $(seq 1 90); do connected && break; sleep 2; done
connected || { echo "ERROR: the participant never joined a synchronizer — see $SANDBOX_LOG"; exit 1; }

echo "==> allocating parties + creating policies (Init:initialize)"
# `daml script` runs against the 3.x SDK from the repo root (the project's
# daml.yaml pins the same 3.x SDK, so the DAR and the runner agree).
( cd "$DAML_DIR" && daml script \
    --dar "$DAR" \
    --script-name Init:initialize \
    --ledger-host localhost --ledger-port "$LEDGER_PORT" \
    --output-file "$INIT_OUT" )

echo "==> writing .env.local"
PARTY_MAP="$(node -e '
  const j = require(process.argv[1]);
  const map = Object.fromEntries((j.parties || []).map(p => [p.slug, p.party]));
  process.stdout.write(JSON.stringify(map));
' "$INIT_OUT")"

cat > "$ROOT/.env.local" <<EOF
# Written by scripts/localnet.sh — points the app at the live LocalNet ledger.
NEXT_PUBLIC_LEDGER_MODE=json-api
LEDGER_URL=http://localhost:$JSON_PORT
# Template ids use the package-name reference ('#canton-resilience:Main:Policy').
LEDGER_PACKAGE_NAME=canton-resilience
# JSON Ledger API v2 requires an explicit user-id; a sandbox without
# authorization cannot default it from a token.
LEDGER_USER_ID=ledger-api-user
LEDGER_PARTY_MAP=$PARTY_MAP
EOF

echo ""
echo "LocalNet is up."
echo "  Ledger gRPC          : localhost:$LEDGER_PORT"
echo "  JSON Ledger API v2   : http://localhost:$JSON_PORT"
echo "  Parties              : $PARTY_MAP"
echo "  Sandbox log          : $SANDBOX_LOG"
echo ""
echo "Now run:  npm run dev   (then open http://localhost:3000)"
echo "Stop:     ./scripts/localnet.sh stop"
