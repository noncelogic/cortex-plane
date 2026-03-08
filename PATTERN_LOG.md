# Pattern Log

> Bug classes, root causes, and preventative controls.
> Updated as part of the [AQS completion gate](AGENT_QUALITY_SYSTEM.md#completion-gate).

Last updated: 2026-03-08

Seeded from issues #424–#463 (2026-03-08 test session).

---

## Class 1: Data Boundary Drift

**Definition:** Two sides of a data boundary (DB schema ↔ application code) diverge silently.

### Instances

| Issue | Title | Root Cause | Fix |
|-------|-------|------------|-----|
| #424 | Duplicate Telegram channel creation allowed | Missing unique constraint on name+type | Added DB-level uniqueness guard |
| #425 | Deleting in-use Telegram channel succeeds | No FK check before delete | Added safety check for active bindings |
| #444 | LLM credential binding exists but execution reports 'No LLM credential available' | Credential lookup query didn't match binding shape | Fixed resolution query |

### Preventative Controls

- **Migration review:** Every migration PR must verify that application code (routes, services) handles the new/changed schema.
- **FK integrity tests:** Integration tests that create and delete bound resources in sequence.
- **Enum sync check:** `credential_class` enum values in code must match DB enum exactly.

---

## Class 2: UX Boundary Inconsistency

**Definition:** UI elements exist but their wiring to backend actions is missing, broken, or mismatched.

### Instances

| Issue | Title | Root Cause | Fix |
|-------|-------|------------|-----|
| #426 | Agent state badge shows BOOTING while backend reports ACTIVE | Frontend polling used stale initial state | Fixed state reconciliation |
| #427 | Remove channel button does not remove channel | Button handler missing or calling wrong endpoint | Wired button to correct API call |
| #437 | Failed job detail panel often empty | Execution steps not included in job query response | Expanded query to include steps |
| #445 | Disconnect button on credential/channel does not work | Click handler was a no-op stub | Implemented handler |
| #446 | Settings page is broken | Render error in settings component | Fixed component |
| #449 | Users tab grant management not functional | Grant CRUD handlers missing | Implemented grant management (#449) |
| #455 | Comprehensive button/action audit | Many buttons were dead stubs | Removed stubs, unimplemented endpoints return 501 (#455) |

### Preventative Controls

- **Interactive element audit:** Every UI component with a click/submit handler must have a corresponding working API call or an explicit 501 stub.
- **Dead code sweep:** PR template asks "are there any stub handlers in the changed files?"
- **State display tests:** Agent/job status displayed in UI must match API response within one polling interval.

---

## Class 3: Auth/Env Boundary Drift

**Definition:** Runtime configuration, credentials, or authorization state doesn't propagate correctly across system boundaries.

### Instances

| Issue | Title | Root Cause | Fix |
|-------|-------|------------|-----|
| #428 | Telegram inbound messages create no events/jobs | Adapter not processing webhook updates | Fixed webhook→event pipeline |
| #430 | DB channel config updates not applied to adapter | Adapter read config from env, not DB | Changed adapter to use DB config |
| #443 | No API to reset circuit breaker | Missing endpoint for quarantine recovery | Needs reset endpoint |
| #448 | Zero-grant allowlist silently drops messages | Guard treated empty allowlist as "allow all" | Changed to explicit deny with feedback |
| #450 | Config errors count toward circuit breaker | All failures incremented breaker equally | Excluded config/credential errors from count (#450) |

### Preventative Controls

- **Config source test:** For each adapter, verify that runtime config comes from DB (not env) after initial bootstrap.
- **Auth boundary test:** Test the zero-grant, single-grant, and multi-grant cases explicitly.
- **Circuit breaker classification:** Failures must be classified (transient vs config) before incrementing breaker.

---

## Class 4: Feature Parity Loss

**Definition:** An advertised feature (endpoint, UI action, integration) doesn't work because a dependency changed or was never fully wired.

### Instances

| Issue | Title | Root Cause | Fix |
|-------|-------|------------|-----|
| #431 | Agent chat sends message but no response | Chat endpoint didn't trigger job execution | Fixed execution pipeline wiring |
| #438 | Approvals endpoint contract mismatch | Frontend Zod schema didn't match API response shape | Aligned schema with API |
| #454 | Dashboard endpoints 404 | Routes not registered in app | Registered missing routes (#454) |
| #463 | Content-Type set on bodyless requests | apiFetch always set JSON header | Conditional Content-Type only when body present (#463) |

### Preventative Controls

- **Route registration test:** Every route defined in route files must be reachable (200/4xx, not 404).
- **Schema alignment test:** Frontend Zod schemas must validate against actual API response fixtures.
- **Feature audit update:** Every merged PR that adds/changes a feature must update FEATURE_AUDIT.md.

---

## Adding New Patterns

When a bug doesn't fit an existing class:

1. Create a new class section with definition, instances table, and preventative controls.
2. Add the class to the summary table in [AGENT_QUALITY_SYSTEM.md](AGENT_QUALITY_SYSTEM.md#bug-classes).
3. Reference the class in the PR that fixes the bug.
