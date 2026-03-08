## Checklist

- [ ] If this PR changes an API response shape: updated the matching fixture + dashboard schema
- [ ] If this PR changes a dashboard Zod schema: verified field names against API fixture

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

### Knowledge artifact updates
<!-- Which AQS docs were updated? (FEATURE_AUDIT.md, FLOW_MATRIX.md, PATTERN_LOG.md) -->
- [ ] FEATURE_AUDIT.md
- [ ] FLOW_MATRIX.md
- [ ] PATTERN_LOG.md
- [ ] N/A — no feature/flow/pattern changes
