# Demo Quality Checklist — Go/No-Go

Run before every demo, staging promotion, or production deploy.
Ref: GitHub issue #153 — demo quality audit.

---

## 1. Mock Data Gate

- [ ] Dashboard does **not** show hardcoded KPI values (5 agents / 3 jobs / 7 approvals / 8 memory)
- [ ] Job detail drawer shows "Unable to load" on API error — never fabricated steps/logs
- [ ] Pulse page shows empty state or real content — no fake articles
- [ ] Memory page shows empty state — no fabricated infrastructure records
- [ ] Browser observation shows empty state — no fake GitHub/Stack Overflow tabs

**Quick smoke**: Open DevTools Network tab, reload dashboard. Verify all `/api/*` calls
return real responses (200) or proper errors (404/500) — never silently replaced by mock data.

## 2. API Contract Health

- [ ] Dashboard home loads KPI cards from live API (`/agents`, `/jobs`, `/approvals`)
- [ ] Agents page lists real agents from `/agents` endpoint
- [ ] Jobs page loads from `/agents/:id/jobs` (or top-level `/jobs` once implemented)
- [ ] Approvals page loads from `/approvals` — SSE stream connects
- [ ] No 404 errors in browser console for known dashboard routes
- [ ] Error banner shows correct classification:
  - "Control plane unavailable" for connection failures
  - "Feature not available" for 404 (unimplemented endpoints)
  - "Authentication required" for 401
  - "Server error" for 500

## 3. Auth / Session Integrity

- [ ] Visiting `/login` when already authenticated redirects to dashboard
- [ ] OAuth callback stores session and redirects to `/` with correct identity
- [ ] User menu shows **name + email** (not just "Operator" with role badge)
- [ ] Signing out clears session and redirects to `/login`
- [ ] Protected pages show auth-gated content only after session is verified
- [ ] Settings page redirects to `/login` when unauthenticated

## 4. Visual / UX Consistency

- [ ] All pages have loading skeletons (no blank flashes)
- [ ] All pages have empty states when no data exists
- [ ] Error banners appear on API failure — never silent failures
- [ ] No `console.log` statements visible in production browser console
- [ ] Dark mode renders correctly on all pages (no raw `slate-*` color leaks)

## 5. Deployment Readiness

- [ ] Production kustomize overlay uses **immutable image tags** (SHA or semver, never `:latest`)
- [ ] `ghcr-secret` Kubernetes secret exists and contains a valid (non-expired) GHCR PAT
- [ ] `make preflight` passes all checks
- [ ] Smoke test passes: `scripts/smoke-test.sh` (local) or `scripts/smoke-test-cluster.sh` (k8s)
- [ ] No hardcoded credentials in deploy manifests (check `deploy/k8s/overlays/prod/`)
- [ ] Tailscale proxy image is pinned to a specific version (not `:latest`)

## 6. Regression Guards

- [ ] `pnpm test` passes for `packages/dashboard`
- [ ] `pnpm test` passes for `packages/control-plane`
- [ ] `pnpm lint` passes at repo root
- [ ] `pnpm build` succeeds for dashboard (Next.js build)
- [ ] CI workflow `validate-manifests` passes

---

## Go / No-Go Decision

| Category                 | Status      |
| ------------------------ | ----------- |
| Mock data gate           | PASS / FAIL |
| API contract health      | PASS / FAIL |
| Auth / session integrity | PASS / FAIL |
| Visual / UX consistency  | PASS / FAIL |
| Deployment readiness     | PASS / FAIL |
| Regression guards        | PASS / FAIL |

**Rule**: All categories must PASS for go. Any single FAIL is a no-go.
