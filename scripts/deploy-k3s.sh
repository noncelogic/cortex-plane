#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-cortex}"
OVERLAY_DIR="${OVERLAY_DIR:-deploy/k8s/overlays/prod}"
IMAGE_PREFIX="${IMAGE_PREFIX:-ghcr.io/noncelogic/cortex}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300s}"
RESTORE_OVERLAY="${RESTORE_OVERLAY:-1}"

if [ -n "${IMAGE_TAG:-}" ]; then
  TAG="$IMAGE_TAG"
elif [ -n "${GITHUB_SHA:-}" ]; then
  TAG="${GITHUB_SHA:0:7}"
else
  echo "ERROR: IMAGE_TAG or GITHUB_SHA must be set" >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $1" >&2
    exit 1
  fi
}

check_http() {
  local url="$1"
  local expected_regex="$2"
  local label="$3"

  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo "000")"
  if [[ "$status" =~ $expected_regex ]]; then
    echo "PASS: ${label} returned HTTP ${status}"
  else
    echo "ERROR: ${label} expected ${expected_regex}, got HTTP ${status}" >&2
    return 1
  fi
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-20}"
  local sleep_seconds="${3:-2}"

  local i
  for i in $(seq 1 "$attempts"); do
    if curl -sS -o /dev/null --max-time 5 "$url"; then
      return 0
    fi
    sleep "$sleep_seconds"
  done

  echo "ERROR: timeout waiting for ${url}" >&2
  return 1
}

pick_port() {
  shuf -i "$1"-"$2" -n 1
}

require_cmd kubectl
require_cmd kustomize
require_cmd curl
require_cmd shuf

if [ ! -d "$OVERLAY_DIR" ]; then
  echo "ERROR: overlay directory not found: $OVERLAY_DIR" >&2
  exit 1
fi

OVERLAY_KUSTOMIZATION="$OVERLAY_DIR/kustomization.yaml"
if [ ! -f "$OVERLAY_KUSTOMIZATION" ]; then
  echo "ERROR: missing kustomization: $OVERLAY_KUSTOMIZATION" >&2
  exit 1
fi

echo "Deploying to namespace '$NAMESPACE' using overlay '$OVERLAY_DIR'"
echo "Using immutable image tag: $TAG"

backup_file=""
if [ "$RESTORE_OVERLAY" = "1" ]; then
  backup_file="$(mktemp)"
  cp "$OVERLAY_KUSTOMIZATION" "$backup_file"
fi

PF_CP_PID=""
PF_DASH_PID=""
cleanup() {
  if [ -n "$PF_CP_PID" ]; then
    kill "$PF_CP_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$PF_DASH_PID" ]; then
    kill "$PF_DASH_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$backup_file" ] && [ -f "$backup_file" ]; then
    cp "$backup_file" "$OVERLAY_KUSTOMIZATION"
    rm -f "$backup_file"
  fi
}
trap cleanup EXIT

pushd "$OVERLAY_DIR" >/dev/null
manifest_before="$(kustomize build .)"

images=(
  "${IMAGE_PREFIX}-control-plane=${IMAGE_PREFIX}-control-plane:${TAG}"
  "${IMAGE_PREFIX}-dashboard=${IMAGE_PREFIX}-dashboard:${TAG}"
)

if echo "$manifest_before" | grep -q 'cortex-playwright-sidecar'; then
  sidecar_repo="$(echo "$manifest_before" | sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]]*cortex-playwright-sidecar)(:[^[:space:]]+)?$/\1/p' | head -n 1)"
  if [ -z "$sidecar_repo" ]; then
    sidecar_repo="${IMAGE_PREFIX}-playwright-sidecar"
  fi
  images+=("${sidecar_repo}=${sidecar_repo}:${TAG}")
  echo "Detected sidecar image in manifests; pinning tag for $sidecar_repo"
fi

kustomize edit set image "${images[@]}"
popd >/dev/null

echo "Applying manifests"
kubectl apply -k "$OVERLAY_DIR"

echo "Waiting for rollout status"
rollout_targets=(control-plane dashboard)
for optional in qdrant postgres; do
  if kubectl -n "$NAMESPACE" get "deployment/${optional}" >/dev/null 2>&1; then
    rollout_targets+=("$optional")
  fi
done

for deploy in "${rollout_targets[@]}"; do
  kubectl -n "$NAMESPACE" rollout status "deployment/${deploy}" --timeout="$ROLLOUT_TIMEOUT"
done

echo "Running smoke checks"
CP_PORT="$(pick_port 32000 36999)"
DASH_PORT="$(pick_port 37000 41999)"

kubectl -n "$NAMESPACE" port-forward service/control-plane "${CP_PORT}:4000" >/tmp/cortex-pf-control-plane.log 2>&1 &
PF_CP_PID=$!
kubectl -n "$NAMESPACE" port-forward service/dashboard "${DASH_PORT}:3000" >/tmp/cortex-pf-dashboard.log 2>&1 &
PF_DASH_PID=$!

wait_for_http "http://127.0.0.1:${CP_PORT}/healthz"
wait_for_http "http://127.0.0.1:${DASH_PORT}/"

check_http "http://127.0.0.1:${CP_PORT}/healthz" '^200$' 'control-plane /healthz'
check_http "http://127.0.0.1:${CP_PORT}/readyz" '^200$' 'control-plane /readyz'
check_http "http://127.0.0.1:${DASH_PORT}/" '^(200|301|302|307|308)$' 'dashboard /'

echo "Deployed images"
for deploy in control-plane dashboard; do
  kubectl -n "$NAMESPACE" get "deployment/${deploy}" -o jsonpath='{.spec.template.spec.containers[*].name}{"="}{.spec.template.spec.containers[*].image}{"\n"}'
done

echo "Deployment completed successfully"
