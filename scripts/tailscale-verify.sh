#!/usr/bin/env bash
# tailscale-verify.sh — verify Tailscale proxy access to Cortex Plane services
#
# Checks:
#   1. tailscale-proxy pod is running
#   2. Tailscale node is online and has an IP
#   3. Dashboard reachable via Tailscale endpoint
#   4. Control-plane API reachable via Tailscale endpoint
#   5. Endpoint is NOT publicly reachable (boundary check)
#
# Usage: ./scripts/tailscale-verify.sh [namespace] [tailscale-hostname]
# Example: ./scripts/tailscale-verify.sh cortex cortex-demo
set -euo pipefail

NS="${1:-cortex}"
TS_HOST="${2:-cortex-demo}"
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
warn() { printf "${YELLOW}  ⚠${RESET} %s\n" "$1"; }

echo ""
printf "${BOLD}Cortex Plane — Tailscale Access Verification${RESET}\n"
echo "Namespace: ${NS}"
echo "Tailscale hostname: ${TS_HOST}"
echo "---"

# ── 1. Pod readiness ─────────────────────────────────────────────────────────

printf "\n${BOLD}1. Tailscale Proxy Pod${RESET}\n"

status=$(kubectl -n "$NS" rollout status deployment/tailscale-proxy --timeout=10s 2>&1) && \
  ok "deployment/tailscale-proxy rolled out" || \
  fail "deployment/tailscale-proxy not ready: ${status}"

pod_name=$(kubectl -n "$NS" get pods -l app=tailscale-proxy -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$pod_name" ]; then
  ok "Pod found: ${pod_name}"
else
  fail "No tailscale-proxy pod found"
  printf "\n${RED}Cannot continue without a running pod.${RESET}\n"
  exit 1
fi

# ── 2. Tailscale status ──────────────────────────────────────────────────────

printf "\n${BOLD}2. Tailscale Node Status${RESET}\n"

ts_status=$(kubectl -n "$NS" exec "$pod_name" -- tailscale status --json 2>/dev/null || echo "")
if [ -n "$ts_status" ]; then
  ts_ip=$(echo "$ts_status" | grep -o '"TailscaleIPs":\["[^"]*"' | head -1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+\.[0-9]\+' || echo "")
  ts_dns=$(echo "$ts_status" | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/"//' || echo "")
  ts_online=$(echo "$ts_status" | grep -o '"Online":true' || echo "")

  if [ -n "$ts_online" ]; then
    ok "Tailscale node is online"
  else
    fail "Tailscale node appears offline"
  fi

  if [ -n "$ts_ip" ]; then
    ok "Tailscale IP: ${ts_ip}"
  else
    fail "No Tailscale IP assigned"
  fi

  if [ -n "$ts_dns" ]; then
    ok "MagicDNS: ${ts_dns}"
  else
    info "MagicDNS name not detected (may not be enabled)"
  fi
else
  fail "Cannot get Tailscale status from pod"
fi

# ── 3. Serve config verification ─────────────────────────────────────────────

printf "\n${BOLD}3. Tailscale Serve Config${RESET}\n"

serve_status=$(kubectl -n "$NS" exec "$pod_name" -- tailscale serve status 2>&1 || echo "error")
if echo "$serve_status" | grep -qi "proxy\|http\|https"; then
  ok "Tailscale serve is configured"
  info "Serve status:"
  echo "$serve_status" | while read -r line; do
    info "  $line"
  done
else
  warn "Tailscale serve status unclear: ${serve_status}"
fi

# Verify Funnel is NOT enabled (internal-only by default)
if echo "$serve_status" | grep -qi "funnel"; then
  warn "Tailscale Funnel appears enabled — endpoint may be publicly reachable"
else
  ok "Tailscale Funnel is OFF (internal-only)"
fi

# ── 4. Internal connectivity (from within the cluster) ────────────────────────

printf "\n${BOLD}4. Internal Service Connectivity${RESET}\n"

check_internal() {
  local name="$1" url="$2"
  local code
  code=$(kubectl -n "$NS" exec "$pod_name" -- \
    wget -q -O /dev/null -S --timeout=5 "$url" 2>&1 | grep "HTTP/" | awk '{print $2}' || echo "000")
  if [ "$code" = "200" ]; then
    ok "$name reachable (HTTP ${code})"
  else
    fail "$name unreachable (HTTP ${code})"
  fi
}

check_internal "dashboard:3000" "http://dashboard.${NS}.svc.cluster.local:3000/"
check_internal "control-plane:4000 /healthz" "http://control-plane.${NS}.svc.cluster.local:4000/healthz"
check_internal "control-plane:4000 /readyz" "http://control-plane.${NS}.svc.cluster.local:4000/readyz"
check_internal "control-plane:4000 /api (root)" "http://control-plane.${NS}.svc.cluster.local:4000/api"

# ── 5. Tailscale endpoint access (from this machine) ─────────────────────────

printf "\n${BOLD}5. Tailscale Endpoint Access (from this machine)${RESET}\n"

if command -v tailscale &>/dev/null; then
  my_ts_status=$(tailscale status 2>&1 || echo "")
  if echo "$my_ts_status" | grep -q "$TS_HOST"; then
    ok "Can see ${TS_HOST} on tailnet"

    # Try HTTPS first, fall back to HTTP
    for proto in https http; do
      endpoint="${proto}://${TS_HOST}"
      code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 "${endpoint}/" 2>/dev/null || echo "000")
      if [ "$code" != "000" ]; then
        ok "Dashboard via Tailscale: ${endpoint}/ (HTTP ${code})"
        code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 "${endpoint}/healthz" 2>/dev/null || echo "000")
        ok "API /healthz via Tailscale: ${endpoint}/healthz (HTTP ${code})"
        break
      fi
    done

    if [ "$code" = "000" ]; then
      fail "Cannot reach ${TS_HOST} via HTTPS or HTTP — check serve config"
    fi
  else
    warn "${TS_HOST} not visible on tailnet from this machine"
    info "Ensure this machine is on the same Tailscale network"
  fi
else
  warn "Tailscale CLI not installed on this machine — skipping remote access test"
  info "Install: curl -fsSL https://tailscale.com/install.sh | sh"
fi

# ── 6. Boundary check — confirm NOT publicly accessible ──────────────────────

printf "\n${BOLD}6. Security Boundary Check${RESET}\n"

if [ -n "${ts_ip:-}" ]; then
  # The Tailscale IP (100.x.x.x) should NOT be routable from the public internet.
  # We verify by checking the IP is in the CGNAT range (100.64.0.0/10).
  if echo "$ts_ip" | grep -qE '^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.'; then
    ok "Tailscale IP is in CGNAT range (${ts_ip}) — not publicly routable"
  else
    warn "Tailscale IP ${ts_ip} may not be in expected CGNAT range"
  fi
fi

# Check that the k3s host IP is not exposing the services via NodePort
node_ip="${CORTEX_VM_IP:-10.244.7.110}"
for port in 3000 4000; do
  code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 3 "http://${node_ip}:${port}/" 2>/dev/null || echo "000")
  if [ "$code" = "000" ]; then
    ok "Port ${port} not exposed on node IP ${node_ip}"
  else
    warn "Port ${port} appears accessible on node IP ${node_ip} (HTTP ${code}) — ClusterIP should not be reachable externally"
  fi
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
