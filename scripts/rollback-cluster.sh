#!/usr/bin/env bash
# rollback-cluster.sh — roll back Cortex Plane app deployments on k8s/k3s
#
# Rolls back control-plane and dashboard to the previous revision,
# or to a specific image tag if provided.
#
# Usage:
#   ./scripts/rollback-cluster.sh                     # undo to previous revision
#   ./scripts/rollback-cluster.sh --tag <sha>          # deploy a specific tag
#   ./scripts/rollback-cluster.sh --namespace <ns>     # custom namespace (default: cortex)
set -euo pipefail

NS="cortex"
TAG=""
BOLD='\033[1m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
RESET='\033[0m'

usage() {
  echo "Usage: $0 [--namespace <ns>] [--tag <sha>]"
  echo ""
  echo "Options:"
  echo "  --namespace <ns>   Kubernetes namespace (default: cortex)"
  echo "  --tag <sha>        Roll forward to a specific image tag instead of undo"
  echo "  --help             Show this help"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NS="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

REGISTRY="ghcr.io/noncelogic"
APP_DEPLOYS=(control-plane dashboard)

echo ""
printf "${BOLD}Cortex Plane — Cluster Rollback${RESET}\n"
echo "Namespace: ${NS}"
echo "---"

# ── Show current state ───────────────────────────────────────────────────────

printf "\n${BOLD}Current state:${RESET}\n"
for deploy in "${APP_DEPLOYS[@]}"; do
  img=$(kubectl -n "$NS" get "deployment/$deploy" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
  printf "  ${YELLOW}%s${RESET}: %s\n" "$deploy" "$img"
done

# ── Execute rollback ─────────────────────────────────────────────────────────

if [ -n "$TAG" ]; then
  # Roll to a specific tag
  printf "\n${BOLD}Rolling to tag: %s${RESET}\n" "$TAG"
  for deploy in "${APP_DEPLOYS[@]}"; do
    image="${REGISTRY}/cortex-${deploy}:${TAG}"
    printf "  Setting %s → %s\n" "$deploy" "$image"
    kubectl -n "$NS" set image "deployment/$deploy" "$deploy=$image"
  done
else
  # Undo to previous revision
  printf "\n${BOLD}Rolling back to previous revision${RESET}\n"
  for deploy in "${APP_DEPLOYS[@]}"; do
    printf "  Undoing %s...\n" "$deploy"
    kubectl -n "$NS" rollout undo "deployment/$deploy"
  done
fi

# ── Wait for rollout ─────────────────────────────────────────────────────────

printf "\n${BOLD}Waiting for rollouts...${RESET}\n"
ALL_OK=true
for deploy in "${APP_DEPLOYS[@]}"; do
  if kubectl -n "$NS" rollout status "deployment/$deploy" --timeout=120s 2>&1; then
    printf "  ${GREEN}✓${RESET} %s rolled out\n" "$deploy"
  else
    printf "  ${RED}✗${RESET} %s rollout failed\n" "$deploy"
    ALL_OK=false
  fi
done

# ── Verify ───────────────────────────────────────────────────────────────────

printf "\n${BOLD}Post-rollback state:${RESET}\n"
for deploy in "${APP_DEPLOYS[@]}"; do
  img=$(kubectl -n "$NS" get "deployment/$deploy" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
  printf "  ${GREEN}%s${RESET}: %s\n" "$deploy" "$img"
done

echo ""
if [ "$ALL_OK" = true ]; then
  printf "${GREEN}Rollback complete.${RESET} Run smoke tests to verify:\n"
  echo "  ./scripts/smoke-test-cluster.sh ${NS}"
  exit 0
else
  printf "${RED}Rollback had errors. Check pod status:${RESET}\n"
  echo "  kubectl -n ${NS} get pods"
  echo "  kubectl -n ${NS} describe pods"
  exit 1
fi
