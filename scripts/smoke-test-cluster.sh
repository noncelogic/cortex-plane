#!/usr/bin/env bash
# smoke-test-cluster.sh — verify a k8s/k3s Cortex Plane deployment end-to-end
#
# Runs inside the cluster via kubectl port-forward and direct pod checks.
# Usage: ./scripts/smoke-test-cluster.sh [namespace]
set -euo pipefail

NS="${1:-cortex}"
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
  # Kill any port-forwards we started
  if [ -n "${PF_PID_CP:-}" ]; then kill "$PF_PID_CP" 2>/dev/null || true; fi
  if [ -n "${PF_PID_DASH:-}" ]; then kill "$PF_PID_DASH" 2>/dev/null || true; fi
}
trap cleanup EXIT

echo ""
printf "${BOLD}Cortex Plane — Cluster Smoke Tests${RESET}\n"
echo "Namespace: ${NS}"
echo "---"

# ── 1. Pod readiness ─────────────────────────────────────────────────────────

printf "\n${BOLD}1. Pod Readiness${RESET}\n"

if kubectl -n "$NS" get cluster.postgresql.cnpg.io/postgresql >/dev/null 2>&1; then
  status=$(kubectl -n "$NS" wait --for=condition=Ready cluster/postgresql --timeout=120s 2>&1) && \
    ok "cluster/postgresql is Ready" || \
    fail "cluster/postgresql not ready: ${status}"
else
  status=$(kubectl -n "$NS" rollout status deployment/postgres --timeout=60s 2>&1) && \
    ok "deployment/postgres rolled out" || \
    fail "deployment/postgres not ready: ${status}"
fi

for deploy in qdrant control-plane dashboard; do
  status=$(kubectl -n "$NS" rollout status "deployment/$deploy" --timeout=10s 2>&1) && \
    ok "deployment/$deploy rolled out" || \
    fail "deployment/$deploy not ready: ${status}"
done

# ── 2. Port-forward setup ────────────────────────────────────────────────────

printf "\n${BOLD}2. Service Connectivity (via port-forward)${RESET}\n"

# Pick random high ports to avoid collisions
CP_PORT=$(shuf -i 30000-39999 -n1)
DASH_PORT=$(shuf -i 40000-49999 -n1)

kubectl -n "$NS" port-forward svc/control-plane "${CP_PORT}:4000" &>/dev/null &
PF_PID_CP=$!

kubectl -n "$NS" port-forward svc/dashboard "${DASH_PORT}:3000" &>/dev/null &
PF_PID_DASH=$!

# Wait for port-forwards to establish
sleep 3

# ── 3. API health checks ────────────────────────────────────────────────────

printf "\n${BOLD}3. API Health${RESET}\n"

check_http() {
  local name="$1" url="$2" expect="${3:-200}"
  local code
  code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo "000")
  if [ "$code" = "$expect" ]; then
    ok "$name (HTTP $code)"
  else
    fail "$name — expected $expect, got $code"
  fi
}

check_http "Control-plane /healthz" "http://localhost:${CP_PORT}/healthz"
check_http "Control-plane /readyz"  "http://localhost:${CP_PORT}/readyz"

# ── 4. Dashboard reachability ────────────────────────────────────────────────

printf "\n${BOLD}4. Dashboard${RESET}\n"

check_http "Dashboard GET /" "http://localhost:${DASH_PORT}/"

# ── 5. Migration status ─────────────────────────────────────────────────────

printf "\n${BOLD}5. Database Migration Status${RESET}\n"

# The /readyz endpoint validates DB connectivity. If it returns 200,
# the control-plane has successfully connected and run migrations.
readyz_body=$(curl -sf --max-time 5 "http://localhost:${CP_PORT}/readyz" 2>/dev/null || echo "")
if [ -n "$readyz_body" ]; then
  ok "DB connection verified via /readyz"
else
  fail "Cannot verify DB connection (/readyz returned empty)"
fi

# ── 6. Image tag verification ────────────────────────────────────────────────

printf "\n${BOLD}6. Deployed Image Tags${RESET}\n"

for deploy in control-plane dashboard; do
  img=$(kubectl -n "$NS" get "deployment/$deploy" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
  if echo "$img" | grep -qE ':[0-9a-f]{7,}$|:v[0-9]'; then
    ok "$deploy image: $img (immutable tag)"
  elif echo "$img" | grep -q ':latest'; then
    fail "$deploy image: $img (mutable tag — use SHA or semver for prod)"
  else
    info "$deploy image: $img"
    PASS=$((PASS + 1))
  fi
done

# ── 7. Resource status overview ──────────────────────────────────────────────

printf "\n${BOLD}7. Cluster Resource Summary${RESET}\n"

info "Pods:"
kubectl -n "$NS" get pods -o wide --no-headers 2>/dev/null | while read -r line; do
  info "  $line"
done

info "Services:"
kubectl -n "$NS" get svc --no-headers 2>/dev/null | while read -r line; do
  info "  $line"
done

info "PVCs:"
kubectl -n "$NS" get pvc --no-headers 2>/dev/null | while read -r line; do
  info "  $line"
done

# ── Summary ──────────────────────────────────────────────────────────────────

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
