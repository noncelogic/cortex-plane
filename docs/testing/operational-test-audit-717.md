# Operational Test Audit (Issue #717)

## Why this exists
Issue #717 asks us to align test coverage with real user-visible failures, not just implementation details.

## Inventory snapshot (2026-03-21)
Scope excludes `node_modules/**` and generated `dist/**` artifacts.

- Total first-party test files: **195**
- End-to-end/browser (`e2e/tests/**`): **5**
- Dashboard component/UI tests (`packages/dashboard/src/__tests__/**`): **31**
- Control-plane integration/mocked-boundary tests (`packages/control-plane/src/__tests__/**`): **103**
- Shared/adapter unit tests (`packages/*/src/__tests__/**`, excluding dashboard/control-plane): **36**
- Other committed test files: **20**

## Risk coverage map (operational boundaries)

### 1) Provider auth post-connect verification truth
- Covered:
  - `packages/control-plane/src/__tests__/auth-connect-callback.test.ts`
    - verifies redirect to `error=connect_unverified` with reason propagation on verification failure.
  - `packages/dashboard/src/__tests__/settings-providers.test.ts`
    - verifies provider-aware formatting of connect verification failures.
- Residual gap:
  - No browser-level E2E assertion that the settings UI renders the failure banner from callback query params end-to-end.

### 2) Connected/healthy UI state only after successful verification
- Covered:
  - callback tests ensure failed verification does **not** produce success redirect.
  - dashboard credential health tests cover status/error derivation logic.
- Residual gap:
  - Missing cross-boundary E2E proving that a provider is shown as healthy only after backend verification success.

### 3) Credential warning provenance/clarity
- Covered:
  - `credential-health.test.ts` checks failure count + lastError rendering behavior.
  - `settings-providers.test.ts` checks provider-specific verification failure messaging.
- Residual gap:
  - No explicit contract test asserting provenance source priority when multiple warning sources exist (status, refresh failure, verification reason).

### 4) Runtime capability disclosure truthfulness
- Covered:
  - `packages/control-plane/src/__tests__/runtime-capability-disclosure.test.ts`
    - asserts unknown/unavailable states and anti-bluff wording.
- Residual gap:
  - No integration test that disclosure text in worker output remains synchronized with API responses surfaced to dashboard consumers.

### 5) Authenticated route/browser shell behavior
- Covered:
  - `e2e/tests/oauth-redirect.spec.ts` verifies unauthenticated root redirects to login.
- Residual gap:
  - Limited auth-shell E2E depth (no matrix for protected nested routes).

### 6) Cross-boundary regression coverage for provider integration states
- Covered:
  - Combined backend callback + dashboard formatting unit tests.
- Residual gap:
  - No single integration/E2E test exercising callback -> persisted credential -> settings state render in one flow.

## Low-value tests / reshaping findings

### Concrete pruning/remediation executed in this issue
- **Pruned brittle aggregate-count assertions** in:
  - `packages/dashboard/src/__tests__/dashboard-feature-audit.test.ts`
- Rationale:
  - Exact totals (e.g., route/page counts) were high-maintenance and low-signal.
  - They fail on benign growth and do not directly protect user-facing behavior.
- Kept high-signal checks:
  - route mapping integrity,
  - explicit stub/phantom tracking,
  - required provenance notes.

## Prioritized follow-up plan

### P1 (highest signal)
1. Add a cross-boundary test for provider connect failure truth:
   - callback returns `connect_unverified` + reason
   - settings UI renders exact provider-scoped warning
2. Add E2E assertion that protected nested routes redirect to login when unauthenticated.

### P2
3. Add integration test for successful connect path proving “healthy” state is rendered only after backend verification success.
4. Add provenance precedence tests for credential warning messaging.

### P3
5. Expand runtime capability disclosure tests to include API response surfaces consumed by dashboard.
6. Audit and remove additional implementation-detail tests that only assert static counts/shape snapshots without operational risk linkage.

## Notes
This document is intentionally a risk-first audit artifact. It should evolve as operational incidents reveal new failure modes.
