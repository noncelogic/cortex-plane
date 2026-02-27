#!/usr/bin/env bash
# preflight-deploy.sh — pre-deployment checks for config, secrets, and images
# Usage: ./scripts/preflight-deploy.sh [env-file]
set -euo pipefail

ENV_FILE="${1:-.env}"
K8S_NAMESPACE="${K8S_NAMESPACE:-cortex}"
GHCR_SECRET_NAME="${GHCR_SECRET_NAME:-ghcr-secret}"
GHCR_REGISTRY="${GHCR_REGISTRY:-ghcr.io}"
GHCR_TOKEN_REPO="${GHCR_TOKEN_REPO:-noncelogic/cortex-control-plane}"
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
  "ghcr.io/noncelogic/cortex-control-plane:dev"
  "ghcr.io/noncelogic/cortex-dashboard:dev"
  "ghcr.io/noncelogic/cortex-playwright-sidecar:dev"
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
K8S_CLUSTER_REACHABLE=0
if command -v kubectl &>/dev/null; then
  ok "kubectl found"
  if kubectl cluster-info &>/dev/null 2>&1; then
    ok "Cluster reachable"
    K8S_CLUSTER_REACHABLE=1
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

# --- 5b. GHCR pull-secret checks (k8s only) ---
printf "\n${BOLD}GHCR Pull Secret${RESET}\n"
if ! command -v kubectl &>/dev/null; then
  warn "kubectl not found (cannot validate ${K8S_NAMESPACE}/${GHCR_SECRET_NAME})"
elif [ "$K8S_CLUSTER_REACHABLE" -ne 1 ]; then
  warn "Cluster not reachable (cannot validate ${K8S_NAMESPACE}/${GHCR_SECRET_NAME})"
else
  if kubectl -n "$K8S_NAMESPACE" get secret "$GHCR_SECRET_NAME" &>/dev/null 2>&1; then
    ok "Secret exists: ${K8S_NAMESPACE}/${GHCR_SECRET_NAME}"
  else
    fail "Missing pull secret ${K8S_NAMESPACE}/${GHCR_SECRET_NAME} (required for ghcr.io images)"
  fi

  secret_type="$(kubectl -n "$K8S_NAMESPACE" get secret "$GHCR_SECRET_NAME" -o jsonpath='{.type}' 2>/dev/null || true)"
  if [ "$secret_type" = "kubernetes.io/dockerconfigjson" ]; then
    ok "${GHCR_SECRET_NAME} has type kubernetes.io/dockerconfigjson"
  else
    fail "${GHCR_SECRET_NAME} must be type kubernetes.io/dockerconfigjson (found: ${secret_type:-unknown})"
  fi

  dockerconfig_b64="$(kubectl -n "$K8S_NAMESPACE" get secret "$GHCR_SECRET_NAME" -o jsonpath='{.data.\.dockerconfigjson}' 2>/dev/null || true)"
  if [ -n "$dockerconfig_b64" ]; then
    ok "${GHCR_SECRET_NAME} contains .dockerconfigjson"
  else
    fail "${GHCR_SECRET_NAME} is missing .dockerconfigjson data"
  fi

  dockerconfig_json="$(printf '%s' "$dockerconfig_b64" | base64 --decode 2>/dev/null || true)"
  if [ -n "$dockerconfig_json" ]; then
    ok "Decoded .dockerconfigjson successfully"
  else
    fail "Could not decode .dockerconfigjson from ${GHCR_SECRET_NAME}"
  fi

  if printf '%s' "$dockerconfig_json" | grep -q "\"${GHCR_REGISTRY}\""; then
    ok "${GHCR_SECRET_NAME} contains ${GHCR_REGISTRY} auth entry"
  else
    fail "${GHCR_SECRET_NAME} does not include ${GHCR_REGISTRY} credentials"
  fi

  dockerconfig_compact="$(printf '%s' "$dockerconfig_json" | tr -d '\n')"
  ghcr_username="$(printf '%s' "$dockerconfig_compact" | sed -nE 's/.*"ghcr\.io"[[:space:]]*:[[:space:]]*\{[^}]*"username"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
  ghcr_password="$(printf '%s' "$dockerconfig_compact" | sed -nE 's/.*"ghcr\.io"[[:space:]]*:[[:space:]]*\{[^}]*"password"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
  ghcr_auth_b64="$(printf '%s' "$dockerconfig_compact" | sed -nE 's/.*"ghcr\.io"[[:space:]]*:[[:space:]]*\{[^}]*"auth"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')"
  ghcr_auth_decoded=""

  if [ -z "$ghcr_username" ] || [ -z "$ghcr_password" ]; then
    ghcr_auth_decoded="$(printf '%s' "$ghcr_auth_b64" | base64 --decode 2>/dev/null || true)"
    ghcr_username="${ghcr_auth_decoded%%:*}"
    ghcr_password="${ghcr_auth_decoded#*:}"
  fi

  if [ -n "$ghcr_username" ] && [ -n "$ghcr_password" ]; then
    ok "Decoded GHCR username/token from ${GHCR_SECRET_NAME}"
  else
    fail "Could not decode GHCR username/token from ${GHCR_SECRET_NAME}"
  fi

  if ! command -v curl &>/dev/null; then
    fail "curl not found (cannot validate GHCR token expiry)"
  else
    ghcr_token_json="$(curl -fsS -u "${ghcr_username}:${ghcr_password}" "https://${GHCR_REGISTRY}/token?service=${GHCR_REGISTRY}&scope=repository:${GHCR_TOKEN_REPO}:pull" 2>/dev/null || true)"
    if [ -n "$ghcr_token_json" ]; then
      ok "GHCR token endpoint reachable with provided credentials"
    else
      fail "GHCR token exchange failed (credentials may be invalid or expired)"
    fi

    ghcr_access_token="$(printf '%s' "$ghcr_token_json" | sed -nE 's/.*"(token|access_token)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\2/p')"
    ghcr_expires_in="$(printf '%s' "$ghcr_token_json" | sed -nE 's/.*"expires_in"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p')"

    if [ -n "$ghcr_access_token" ]; then
      ok "GHCR issued a pull token"
    else
      fail "GHCR token response missing token/access_token"
    fi

    if [[ "$ghcr_expires_in" =~ ^[0-9]+$ ]] && [ "$ghcr_expires_in" -gt 0 ]; then
      ok "GHCR pull token expiry is valid (${ghcr_expires_in}s)"
    else
      fail "GHCR token expiry invalid (expires_in=${ghcr_expires_in:-missing})"
    fi
  fi
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
