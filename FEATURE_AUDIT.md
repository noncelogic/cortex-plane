# Feature Audit

> Advertised vs actual working status for all user-facing features.
> Updated as part of the [AQS completion gate](AGENT_QUALITY_SYSTEM.md#completion-gate).

Last updated: 2026-03-08

## Status Key

| Symbol             | Meaning                                |
| ------------------ | -------------------------------------- |
| :white_check_mark: | Working — verified in test session     |
| :warning:          | Partial — works with caveats or guards |
| :x:                | Broken — not functional                |
| :construction:     | Not yet implemented                    |

## Feature Matrix

### Authentication & Authorization

| Feature                                 | Status             | Notes                                                                | Last Verified |
| --------------------------------------- | ------------------ | -------------------------------------------------------------------- | ------------- |
| OAuth login (Google)                    | :white_check_mark: | Functional                                                           | 2026-03-08    |
| Credential storage (LLM provider)       | :white_check_mark: | Via credential-service                                               | 2026-03-08    |
| Credential storage (MCP server)         | :white_check_mark: | Via credential-service                                               | 2026-03-08    |
| Credential storage (tool-specific)      | :white_check_mark: | Via credential-service                                               | 2026-03-08    |
| Credential storage (user-service/OAuth) | :white_check_mark: | Via credential-service                                               | 2026-03-08    |
| Credential management UI                | :x:                | Disconnect button non-functional (#445), settings page broken (#446) | 2026-03-08    |
| Channel auth guard                      | :warning:          | Implemented but zero-grant allowlist silently drops (#448)           | 2026-03-08    |

### Channels

| Feature            | Status             | Notes                                                                              | Last Verified |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------- | ------------- |
| Channel CRUD (API) | :white_check_mark: | With safety guards after #424/#425 fixes                                           | 2026-03-08    |
| Channel CRUD (UI)  | :warning:          | Remove button was broken (#427), audit in progress (#455)                          | 2026-03-08    |
| Telegram inbound   | :x:                | Channel configured but messages create no events (#428), config not applied (#430) | 2026-03-08    |
| Discord adapter    | :construction:     | Adapter exists, not fully wired                                                    | 2026-03-08    |

### Agents & Execution

| Feature                      | Status             | Notes                                                               | Last Verified |
| ---------------------------- | ------------------ | ------------------------------------------------------------------- | ------------- |
| Agent CRUD                   | :white_check_mark: | Functional                                                          | 2026-03-08    |
| Agent chat (dashboard)       | :x:                | Sends message but no response / no job execution (#431)             | 2026-03-08    |
| Agent state display          | :warning:          | Badge shows BOOTING while backend reports ACTIVE (#426)             | 2026-03-08    |
| LLM credential binding       | :warning:          | Binding exists but execution may fail (#444)                        | 2026-03-08    |
| MCP tool execution           | :white_check_mark: | Client pool + tool bridge functional                                | 2026-03-08    |
| Quarantine / circuit breaker | :warning:          | Fixed config error exclusion (#450), but no manual reset API (#443) | 2026-03-08    |

### Dashboard & UI

| Feature                      | Status             | Notes                                               | Last Verified |
| ---------------------------- | ------------------ | --------------------------------------------------- | ------------- |
| Dashboard summary endpoint   | :white_check_mark: | Fixed in #454                                       | 2026-03-08    |
| Dashboard activity endpoint  | :white_check_mark: | Fixed in #454                                       | 2026-03-08    |
| Dashboard jobs stream        | :white_check_mark: | Fixed in #454                                       | 2026-03-08    |
| Settings page                | :x:                | Broken (#446)                                       | 2026-03-08    |
| Job detail panel             | :warning:          | Failed jobs often show empty detail (#437)          | 2026-03-08    |
| Users tab (grant management) | :white_check_mark: | Fixed in #449                                       | 2026-03-08    |
| Approvals UI                 | :x:                | Endpoint contract mismatch causes toast (#438)      | 2026-03-08    |
| Interactive element audit    | :warning:          | Dead stubs removed, unimplemented return 501 (#455) | 2026-03-08    |

### API Client

| Feature                        | Status             | Notes                               | Last Verified |
| ------------------------------ | ------------------ | ----------------------------------- | ------------- |
| apiFetch (requests with body)  | :white_check_mark: | Functional                          | 2026-03-08    |
| apiFetch (bodyless GET/DELETE) | :white_check_mark: | Fixed Content-Type handling in #463 | 2026-03-08    |
