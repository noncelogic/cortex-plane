# Extensibility Verification Matrix — Browser Tooling + MCP (Issue #727)

_Date:_ 2026-03-21  
_Scope:_ Runtime/extensibility checks so schema/contract parity is not confused with execution readiness.

## How to Reproduce This Audit

```bash
# Dashboard contract + error handling checks
pnpm --filter @cortex/dashboard test -- --runInBand \
  src/__tests__/schema-contract.test.ts \
  src/__tests__/api-client.test.ts \
  src/__tests__/error-handling-audit.test.ts \
  src/__tests__/dashboard-feature-audit.test.ts

# Control plane runtime behavior checks
pnpm --filter @cortex/control-plane test -- --runInBand \
  src/__tests__/stream-routes.test.ts \
  src/__tests__/dashboard-routes.test.ts \
  src/__tests__/mcp-tool-router.test.ts
```

## Verification Matrix

### Browser tooling

| Check                                                 | Result  | Evidence                                                                                                                 |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Steering/action endpoint contract + runtime execution | ✅ PASS | `stream-routes.test.ts`, `schema-contract.test.ts` (`SteerResponseSchema`)                                               |
| Auth handoff behavior                                 | ✅ PASS | `streaming/types.ts` (`browser:auth:handoff`), `oauth-popup.test.ts`                                                     |
| Trace/event propagation to UI                         | ✅ PASS | Trace flow validated; screenshot/event history endpoints return persisted runtime artifacts (`dashboard-routes.test.ts`) |
| Failure paths (auth, invalid action, timeout)         | ✅ PASS | `stream-routes.test.ts`, `api-client.test.ts`, `error-handling-audit.test.ts`                                            |

### MCP

| Check                                               | Result                                   | Evidence                                                                     |
| --------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| MCP server binding + credential resolution          | ✅ PASS                                  | dashboard bindings + `mcp-tool-router.test.ts`                               |
| Tool invocation from agent execution path           | ⚠️ PARTIAL                               | Router-level execution proven; missing full integrated worker-path assertion |
| Result propagation to job/session output            | ⚠️ PARTIAL                               | Stream contracts covered; needs explicit integrated MCP output assertion     |
| Failure paths (missing creds, denied tool, timeout) | ✅ PASS (layered), ⚠️ PARTIAL (full e2e) | unit/layer coverage exists, full worker→UI propagation test pending          |

### Operator surface

| Check                                      | Result  | Evidence                       |
| ------------------------------------------ | ------- | ------------------------------ |
| UI shows actionable errors                 | ✅ PASS | `error-handling-audit.test.ts` |
| Endpoint responses match dashboard schemas | ✅ PASS | `schema-contract.test.ts`      |

## Gap Tickets

- #711 — Browser screenshots/events runtime persistence ✅ resolved
- #712 — MCP full execution-path e2e integration test
- #713 — MCP failure-path propagation integration test

## Acceptance Mapping

- [x] Browser tooling happy-path verified end-to-end
- [x] Browser tooling failure paths verified with actionable errors
- [ ] MCP happy-path verified end-to-end _(tracked by #712)_
- [ ] MCP failure paths verified with actionable errors _(tracked by #713)_
- [x] UI/contract alignment confirmed for extensibility endpoints
- [x] Failing checks itemized into explicit tickets
