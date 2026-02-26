#!/usr/bin/env bash
# preflight-deploy.sh — pre-deployment checks for config, secrets, and images
# Usage: ./scripts/preflight-deploy.sh [env-file]
set -euo pipefail

ENV_FILE="${1:-.env}"
PASS=0
WARN=0
FAIL=0
BOLD='\033[1m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

ok()   { printf "${GREEN}  ✓${RESET} %s\n" "$1"; PASS=$((PASS + 1)); }
warn() { printf "${YELLOW}  ⚠${RESET} %s\n" "$1"; WARN=$((WARN + 1)); }
fail() { printf "${RED}  ✗${RESET} %s\n" "$1"; FAIL=$((FAIL + 1)); }

echo ""
printf "${BOLD}Cortex Plane — Pre-Deploy Checklist${RESET}\n"
echo "---"

# --- 1. Environment file ---
printf "\n${BOLD}Environment${RESET}\n"
if [ -f "$ENV_FILE" ]; then
  ok "Environment file exists: ${ENV_FILE}"
else
  fail "Environment file missing: ${ENV_FILE} (copy from .env.example)"
fi

# --- 2. Required variables ---
printf "\n${BOLD}Required Variables${RESET}\n"
REQUIRED_VARS=(DATABASE_URL)
OPTIONAL_VARS=(QDRANT_URL PORT HOST LOG_LEVEL CREDENTIAL_MASTER_KEY)

if [ -f "$ENV_FILE" ]; then
  for var in "${REQUIRED_VARS[@]}"; do
    if grep -qE "^${var}=" "$ENV_FILE" 2>/dev/null; then
      ok "${var} is set"
    else
      fail "${var} is missing"
    fi
  done

  for var in "${OPTIONAL_VARS[@]}"; do
    if grep -qE "^${var}=" "$ENV_FILE" 2>/dev/null; then
      ok "${var} is set"
    else
      warn "${var} not set (has default)"
    fi
  done
else
  fail "Cannot check variables — env file missing"
fi

# --- 3. Docker ---
printf "\n${BOLD}Docker${RESET}\n"
if command -v docker &>/dev/null; then
  ok "docker CLI found"
  if docker info &>/dev/null; then
    ok "Docker daemon reachable"
  else
    fail "Docker daemon not reachable"
  fi
else
  fail "docker not found"
fi

if command -v docker &>/dev/null && docker compose version &>/dev/null; then
  ok "docker compose available"
else
  fail "docker compose not available"
fi

# --- 4. Image availability (for k8s deploy) ---
printf "\n${BOLD}Container Images (for k8s/prod deploy)${RESET}\n"
IMAGES=(
  "noncelogic/cortex-control-plane:latest"
  "noncelogic/cortex-dashboard:latest"
)
for img in "${IMAGES[@]}"; do
  if docker image inspect "$img" &>/dev/null 2>&1; then
    ok "Local image: ${img}"
  else
    warn "Image not found locally: ${img} (will need pull or build)"
  fi
done

# --- 5. Kubernetes (optional) ---
printf "\n${BOLD}Kubernetes (optional)${RESET}\n"
if command -v kubectl &>/dev/null; then
  ok "kubectl found"
  if kubectl cluster-info &>/dev/null 2>&1; then
    ok "Cluster reachable"
  else
    warn "Cluster not reachable"
  fi
else
  warn "kubectl not found (skip if not deploying to k8s)"
fi

if command -v kustomize &>/dev/null; then
  ok "kustomize found"
else
  warn "kustomize not found (kubectl kustomize works as fallback)"
fi

# --- 6. Node.js toolchain ---
printf "\n${BOLD}Toolchain${RESET}\n"
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  ok "Node.js ${NODE_VER}"
else
  warn "Node.js not found (not needed for container-only deploy)"
fi

if command -v pnpm &>/dev/null; then
  ok "pnpm found"
else
  warn "pnpm not found (not needed for container-only deploy)"
fi

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + WARN + FAIL))
printf "${BOLD}Results: ${GREEN}%d ok${RESET}, ${YELLOW}%d warnings${RESET}, ${RED}%d failures${RESET} (of %d checks)\n" \
  "$PASS" "$WARN" "$FAIL" "$TOTAL"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  printf "${RED}Fix failures before deploying.${RESET}\n"
  exit 1
else
  echo ""
  printf "${GREEN}Preflight passed.${RESET}\n"
  exit 0
fi
