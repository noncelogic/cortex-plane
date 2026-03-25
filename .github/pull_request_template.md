## Checklist

- [ ] If this PR changes an API response shape: updated the matching fixture + dashboard schema
- [ ] If this PR changes a dashboard Zod schema: verified field names against API fixture

## Integration Acceptance Criteria

> Every PR must address all three levels. Mark N/A if truly not applicable.

### Unit — does the feature work in isolation?

- [ ] New/changed logic has unit tests
- [ ] Tests pass locally (`pnpm test`)

### Integration — does it work with the rest of the system?

- [ ] Verified against a running stack (compose or cluster)
- [ ] Cross-package dependencies confirmed (API ↔ dashboard ↔ adapters)

### Regression — did it break anything that was working?

- [ ] Ran full CI locally (`pnpm lint && pnpm typecheck && pnpm test`)
- [ ] Checked sibling surfaces (see AQS section below)
- [ ] No new error toasts or console errors on affected pages

## AQS — Agent Quality System

> Fill in this section for every PR. See [AGENT_QUALITY_SYSTEM.md](/AGENT_QUALITY_SYSTEM.md) for details.

### Flow impacted

<!-- Which critical user flow(s) does this PR touch? Reference FLOW_MATRIX.md -->

### Boundaries touched

<!-- Check all that apply -->

- [ ] Data (schema, FKs, enums, migrations)
- [ ] API (routes, request/response shape, status codes)
- [ ] UX (buttons, forms, state display, error feedback)

### Guarantees preserved / changed

<!-- What invariants hold after this PR? Any contracts changed? -->

### Evidence

<!-- Before/after proof: test output, screenshots, curl responses -->

### Sibling-surface regression scan

<!-- Confirm related surfaces still work. List what you checked. -->

### OpenClaw convergence + velocity declaration (flow-touching PRs)

<!-- Required when PR touches runtime/chat/orchestration flow surfaces -->

- Convergence status (`parity` | `gap-reduction` | `intentional-divergence`):
- Lead-time outcome (`reduced` | `unchanged` | `increased`):
- Running-path verification artifact:
- Stabilization issue link (required if steering rounds > 1 or lead-time increased twice):

### Knowledge artifact updates

<!-- Which AQS docs were updated? (FEATURE_AUDIT.md, FLOW_MATRIX.md, PATTERN_LOG.md) -->

- [ ] FEATURE_AUDIT.md
- [ ] FLOW_MATRIX.md
- [ ] PATTERN_LOG.md
- [ ] N/A — no feature/flow/pattern changes
