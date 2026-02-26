#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ok=0
warn=0
fail=0

pass(){ echo "✓ $1"; ok=$((ok+1)); }
warning(){ echo "⚠ $1"; warn=$((warn+1)); }
error(){ echo "✗ $1"; fail=$((fail+1)); }

echo "Execution Preflight"
echo "==================="

# 1) Ops policy files exist
for f in docs/ops/RULES-OF-ROAD.md docs/ops/EXECUTION-CHECKLIST.md docs/ops/NOW.md; do
  if [[ -f "$f" ]]; then pass "$f present"; else error "$f missing"; fi
done

# 2) Count active Claude Code jobs (best effort)
RUNNING=$(node "$HOME/.openclaw/workspace/skills/openclaw-skill-claude-code/scripts/run.mjs" list 2>/dev/null | grep -c '"status": "running"' || true)
if [[ "$RUNNING" -le 1 ]]; then
  pass "WIP check passed (running jobs: $RUNNING)"
else
  error "WIP violation (running jobs: $RUNNING)"
fi

# 3) Stale in-progress label check
if command -v gh >/dev/null 2>&1; then
  INPROG=$(gh issue list --state open --limit 100 --json number,labels | jq '[.[] | select((.labels|map(.name)|index("status: in-progress"))!=null)] | length' 2>/dev/null || echo 0)
  if [[ "$INPROG" -ge 0 ]]; then
    warning "Open issues with status: in-progress = $INPROG (verify they map to active work)"
  fi
else
  warning "gh CLI unavailable; skipped issue label checks"
fi

echo ""
echo "Results: $ok ok, $warn warnings, $fail failures"
[[ "$fail" -eq 0 ]]
