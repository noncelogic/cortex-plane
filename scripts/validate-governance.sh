#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

ok() {
  printf "  ✓ %s\n" "$1"
  PASS=$((PASS + 1))
}

fail() {
  printf "  ✗ %s\n" "$1"
  FAIL=$((FAIL + 1))
}

require_file() {
  local path="$1"
  if [ -f "$path" ]; then
    ok "Found $path"
  else
    fail "Missing required file: $path"
  fi
}

require_contains() {
  local path="$1"
  local needle="$2"
  if [ ! -f "$path" ]; then
    fail "Cannot inspect missing file: $path"
    return
  fi

  if grep -q "$needle" "$path"; then
    ok "$path contains '$needle'"
  else
    fail "$path missing expected content: '$needle'"
  fi
}

echo ""
echo "Cortex Plane Governance Validation"
echo "---"

require_file "AGENT_QUALITY_SYSTEM.md"
require_file "FEATURE_AUDIT.md"
require_file "FLOW_MATRIX.md"
require_file "PATTERN_LOG.md"
require_file ".github/pull_request_template.md"
require_file ".github/ISSUE_TEMPLATE/bug.yml"
require_file ".github/ISSUE_TEMPLATE/feature.yml"
require_file ".github/ISSUE_TEMPLATE/stabilization.yml"
require_file ".github/ISSUE_TEMPLATE/config.yml"
require_file "docs/ops/engineering-operating-contract.md"

require_contains ".github/pull_request_template.md" "## AQS — Agent Quality System"
require_contains ".github/pull_request_template.md" "### Ownership + autonomy declaration"
require_contains "docs/ops/engineering-operating-contract.md" "## 3) PR contract"
require_contains "docs/ops/engineering-operating-contract.md" "## 4) Deployment topology contract"
require_contains "docs/ops/engineering-operating-contract.md" "## 6) Ownership + autonomy contract"
require_contains "docs/ops/engineering-operating-contract.md" "Project Orchestrator owns"
require_file "docs/ops/ownership-autonomy-matrix.md"
require_contains "docs/ops/ownership-autonomy-matrix.md" "OpenClaw-transition roadmap and sequence planning"
require_contains "docs/ops/ownership-autonomy-matrix.md" "Project Orchestrator"
require_contains "docs/ops/ownership-autonomy-matrix.md" "One alignment decision is the max normal steering budget"


echo ""
echo "---"
printf "Results: %d passed, %d failed\n" "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
