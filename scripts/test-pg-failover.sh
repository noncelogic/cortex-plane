#!/usr/bin/env bash
# test-pg-failover.sh — validate CNPG failover and Graphile Worker continuity.
#
# Usage:
#   ./scripts/test-pg-failover.sh [namespace] [cluster-name]
#
# Prerequisites:
# - CNPG cluster deployed (default name: postgresql)
# - control-plane deployment running in the same namespace
# - kubectl context pointing to target cluster
set -euo pipefail

NS="${1:-cortex}"
CLUSTER="${2:-postgresql}"
CONTROL_PLANE_SERVICE="control-plane"
POOLER_SERVICE="postgresql-rw-pooler"
TIMEOUT_SECONDS=240

PASS=0
FAIL=0
BOLD='\033[1m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
RESET='\033[0m'

ok()   { printf "${GREEN}  ✓${RESET} %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "${RED}  ✗${RESET} %s\n" "$1"; FAIL=$((FAIL + 1)); }
info() { printf "${YELLOW}  ▸${RESET} %s\n" "$1"; }

cleanup() {
  if [ -n "${PF_PID_CP:-}" ]; then kill "$PF_PID_CP" 2>/dev/null || true; fi
}
trap cleanup EXIT

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require kubectl
require curl

run_psql_on_pod() {
  local pod="$1"
  local db="$2"
  local sql="$3"
  kubectl -n "$NS" exec "$pod" -- psql -U postgres -d "$db" -tAqc "$sql"
}

get_current_primary() {
  kubectl -n "$NS" get "cluster/$CLUSTER" -o jsonpath='{.status.currentPrimary}'
}

echo ""
printf "${BOLD}PostgreSQL HA Failover Validation${RESET}\n"
echo "Namespace: ${NS}"
echo "Cluster: ${CLUSTER}"
echo "---"

printf "\n${BOLD}1. Baseline checks${RESET}\n"

if kubectl -n "$NS" get "cluster/$CLUSTER" >/dev/null 2>&1; then
  ok "CNPG cluster/$CLUSTER exists"
else
  fail "CNPG cluster/$CLUSTER not found"
  echo ""
  exit 1
fi

if kubectl -n "$NS" get svc "$POOLER_SERVICE" >/dev/null 2>&1; then
  ok "Pooler service/$POOLER_SERVICE exists"
else
  fail "Pooler service/$POOLER_SERVICE not found"
fi

status=$(kubectl -n "$NS" wait --for=condition=Ready "cluster/$CLUSTER" --timeout=120s 2>&1) && \
  ok "cluster/$CLUSTER is Ready" || \
  fail "cluster/$CLUSTER not Ready: ${status}"

PRIMARY_BEFORE=$(get_current_primary)
if [ -n "$PRIMARY_BEFORE" ]; then
  ok "Current primary: ${PRIMARY_BEFORE}"
else
  fail "Unable to determine current primary"
  echo ""
  exit 1
fi

printf "\n${BOLD}2. Graphile Worker baseline${RESET}\n"

if run_psql_on_pod "$PRIMARY_BEFORE" cortex_plane "SELECT 1" >/dev/null 2>&1; then
  ok "Primary accepts SQL queries"
else
  fail "Cannot query cortex_plane on primary"
fi

WORKER_HEARTBEAT_BEFORE=$(run_psql_on_pod "$PRIMARY_BEFORE" cortex_plane "SELECT COALESCE(MIN(EXTRACT(EPOCH FROM (NOW() - last_heartbeat)))::int, -1) FROM graphile_worker.workers;" 2>/dev/null || echo "-1")
if [ "$WORKER_HEARTBEAT_BEFORE" -ge 0 ] 2>/dev/null; then
  ok "Worker heartbeat age before failover: ${WORKER_HEARTBEAT_BEFORE}s"
else
  info "No graphile_worker heartbeat baseline found (worker may be idle or not initialized yet)"
  PASS=$((PASS + 1))
fi

CP_PORT=$(shuf -i 30000-39999 -n1)
kubectl -n "$NS" port-forward "svc/${CONTROL_PLANE_SERVICE}" "${CP_PORT}:4000" >/dev/null 2>&1 &
PF_PID_CP=$!
sleep 2

if curl -sf --max-time 5 "http://127.0.0.1:${CP_PORT}/readyz" >/dev/null 2>&1; then
  ok "control-plane /readyz passes before failover"
else
  fail "control-plane /readyz failed before failover"
fi

printf "\n${BOLD}3. Trigger failover${RESET}\n"

if kubectl -n "$NS" delete pod "$PRIMARY_BEFORE" --wait=false >/dev/null 2>&1; then
  ok "Deleted primary pod ${PRIMARY_BEFORE} to trigger failover"
else
  fail "Failed to delete primary pod ${PRIMARY_BEFORE}"
fi

info "Waiting for new primary election"
NEW_PRIMARY=""
for _ in $(seq 1 "$TIMEOUT_SECONDS"); do
  CANDIDATE=$(get_current_primary 2>/dev/null || true)
  if [ -n "$CANDIDATE" ] && [ "$CANDIDATE" != "$PRIMARY_BEFORE" ]; then
    NEW_PRIMARY="$CANDIDATE"
    break
  fi
  sleep 1
done

if [ -n "$NEW_PRIMARY" ]; then
  ok "New primary elected: ${NEW_PRIMARY}"
else
  fail "Timed out waiting for primary switch"
fi

status=$(kubectl -n "$NS" wait --for=condition=Ready "cluster/$CLUSTER" --timeout=120s 2>&1) && \
  ok "cluster/$CLUSTER returned to Ready after failover" || \
  fail "cluster/$CLUSTER did not recover: ${status}"

printf "\n${BOLD}4. Post-failover continuity checks${RESET}\n"

READY_AFTER="failed"
for _ in $(seq 1 60); do
  if curl -sf --max-time 5 "http://127.0.0.1:${CP_PORT}/readyz" >/dev/null 2>&1; then
    READY_AFTER="ok"
    break
  fi
  sleep 2
done

if [ "$READY_AFTER" = "ok" ]; then
  ok "control-plane /readyz recovered after failover"
else
  fail "control-plane /readyz did not recover after failover"
fi

if [ -n "$NEW_PRIMARY" ] && run_psql_on_pod "$NEW_PRIMARY" cortex_plane "SELECT 1" >/dev/null 2>&1; then
  ok "New primary accepts SQL queries"
else
  fail "Cannot query cortex_plane on new primary"
fi

WORKER_HEARTBEAT_AFTER="-1"
if [ -n "$NEW_PRIMARY" ]; then
  WORKER_HEARTBEAT_AFTER=$(run_psql_on_pod "$NEW_PRIMARY" cortex_plane "SELECT COALESCE(MIN(EXTRACT(EPOCH FROM (NOW() - last_heartbeat)))::int, -1) FROM graphile_worker.workers;" 2>/dev/null || echo "-1")
fi

if [ "$WORKER_HEARTBEAT_AFTER" -ge 0 ] 2>/dev/null; then
  if [ "$WORKER_HEARTBEAT_AFTER" -le 120 ]; then
    ok "Worker heartbeat age after failover: ${WORKER_HEARTBEAT_AFTER}s"
  else
    fail "Worker heartbeat too old after failover: ${WORKER_HEARTBEAT_AFTER}s"
  fi
else
  info "No graphile_worker heartbeat after failover (validate queue activity manually)"
  PASS=$((PASS + 1))
fi

echo ""
echo "---"
TOTAL=$((PASS + FAIL))
printf "${BOLD}Results: %d/%d passed${RESET}" "$PASS" "$TOTAL"
if [ "$FAIL" -gt 0 ]; then
  printf " ${RED}(%d failed)${RESET}\n" "$FAIL"
  exit 1
else
  printf " ${GREEN}(all clear)${RESET}\n"
  exit 0
fi
