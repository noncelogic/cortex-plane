#!/usr/bin/env bash
# smoke-test.sh — verify the compose stack is healthy end-to-end
# Usage: ./scripts/smoke-test.sh [base_url]
set -euo pipefail

BASE_URL="${1:-http://localhost:4000}"
PASS=0
FAIL=0
BOLD='\033[1m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

check() {
  local name="$1" url="$2" expect="${3:-200}"
  local code
  code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo "000")
  if [ "$code" = "$expect" ]; then
    printf "${GREEN}  ✓${RESET} %s (HTTP %s)\n" "$name" "$code"
    PASS=$((PASS + 1))
  else
    printf "${RED}  ✗${RESET} %s — expected %s, got %s\n" "$name" "$expect" "$code"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
printf "${BOLD}Cortex Plane — Smoke Tests${RESET}\n"
echo "Target: ${BASE_URL}"
echo "---"

# --- Control Plane ---
printf "\n${BOLD}Control Plane${RESET}\n"
check "GET /healthz"  "${BASE_URL}/healthz"
check "GET /readyz"   "${BASE_URL}/readyz"

# --- Qdrant ---
QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
printf "\n${BOLD}Qdrant${RESET}\n"
check "GET /healthz"  "${QDRANT_URL}/healthz"

# --- Postgres (via control-plane readiness — implies DB connection) ---
printf "\n${BOLD}Postgres (implicit via /readyz)${RESET}\n"
check "Control-plane can reach DB"  "${BASE_URL}/readyz"

# --- Dashboard (optional, only if port 3000 is reachable) ---
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3000}"
printf "\n${BOLD}Dashboard (optional)${RESET}\n"
dash_code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 3 "$DASHBOARD_URL" 2>/dev/null || echo "000")
if [ "$dash_code" = "000" ]; then
  printf "  - Skipped (not reachable at %s)\n" "$DASHBOARD_URL"
else
  check "GET /"  "${DASHBOARD_URL}"
fi

# --- Summary ---
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
