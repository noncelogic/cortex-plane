#!/usr/bin/env bash
# run-e2e-cluster.sh — run Playwright E2E tests against a k8s/k3s cluster
#
# Sets up port-forwards, runs the E2E suite, and tears down cleanly.
# Usage: ./scripts/run-e2e-cluster.sh [namespace]
set -euo pipefail

NS="${1:-cortex}"
PF_PID_CP=""
PF_PID_DASH=""
CP_PORT=""
DASH_PORT=""
EXIT_CODE=0

cleanup() {
  echo ""
  echo "Cleaning up port-forwards…"
  [ -n "$PF_PID_CP" ] && kill "$PF_PID_CP" 2>/dev/null || true
  [ -n "$PF_PID_DASH" ] && kill "$PF_PID_DASH" 2>/dev/null || true
}
trap cleanup EXIT

echo "Cortex Plane — E2E Test Runner"
echo "Namespace: ${NS}"
echo "---"

# ── 1. Pick random ports ──────────────────────────────────────────────────────

CP_PORT=$(shuf -i 30000-34999 -n1)
DASH_PORT=$(shuf -i 35000-39999 -n1)

echo "Port-forwarding control-plane → localhost:${CP_PORT}"
kubectl -n "$NS" port-forward svc/control-plane "${CP_PORT}:4000" &>/dev/null &
PF_PID_CP=$!

echo "Port-forwarding dashboard → localhost:${DASH_PORT}"
kubectl -n "$NS" port-forward svc/dashboard "${DASH_PORT}:3000" &>/dev/null &
PF_PID_DASH=$!

# ── 2. Wait for port-forwards ────────────────────────────────────────────────

echo "Waiting for port-forwards to establish…"
for i in $(seq 1 20); do
  if curl -sf -o /dev/null --max-time 2 "http://localhost:${CP_PORT}/healthz" 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: control-plane port-forward timed out" >&2
    exit 1
  fi
  sleep 1
done

for i in $(seq 1 20); do
  if curl -sf -o /dev/null --max-time 2 "http://localhost:${DASH_PORT}/" 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: dashboard port-forward timed out" >&2
    exit 1
  fi
  sleep 1
done

echo "Services reachable."

# ── 3. Run Playwright ─────────────────────────────────────────────────────────

echo ""
echo "Running E2E tests…"
echo "---"

export CP_BASE_URL="http://localhost:${CP_PORT}"
export DASH_BASE_URL="http://localhost:${DASH_PORT}"
export CI="${CI:-true}"

cd "$(dirname "$0")/../e2e"
npx playwright test || EXIT_CODE=$?

echo ""
echo "---"
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "E2E suite: ALL PASSED"
else
  echo "E2E suite: FAILURES DETECTED (exit code ${EXIT_CODE})"
fi

exit "$EXIT_CODE"
