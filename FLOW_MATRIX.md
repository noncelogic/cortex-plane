# Flow Matrix

> Critical user flows mapped to boundary guarantees.
> Updated as part of the [AQS completion gate](AGENT_QUALITY_SYSTEM.md#completion-gate).

Last updated: 2026-03-08

## How to Read This Document

Each flow lists its steps, the boundaries crossed at each step, and the guarantee that must hold. When a PR touches any step in a flow, the entire flow should be smoke-tested.

---

## Flow 1: Login → Dashboard

| Step                     | Boundary   | Guarantee                                                                          |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------- |
| User clicks OAuth login  | UX → API   | Login button triggers OAuth redirect                                               |
| OAuth callback processed | API → Data | Session created, user record upserted                                              |
| Dashboard loads          | API → UX   | `/api/dashboard/summary`, `/api/dashboard/activity` return 200 with expected shape |
| Dashboard renders        | UX         | Summary cards, activity list, and job stream display without error                 |

**Sibling surfaces:** Settings page, navigation bar, session expiry handling.

---

## Flow 2: Channel → Agent Binding

| Step                               | Boundary        | Guarantee                                                       |
| ---------------------------------- | --------------- | --------------------------------------------------------------- |
| Create channel (UI or API)         | UX → API → Data | Channel record created, no duplicates for same name+type (#424) |
| Bind channel to agent              | API → Data      | `agent_channel_binding` row created with valid FKs              |
| Verify binding visible in UI       | Data → API → UX | Agent detail page shows bound channel                           |
| Delete channel (with safety check) | UX → API → Data | In-use channel deletion blocked (#425) or cascades cleanly      |

**Sibling surfaces:** Channel list page, agent detail page, Telegram/Discord adapter config.

---

## Flow 3: Chat → Job → Response

| Step                           | Boundary        | Guarantee                                                |
| ------------------------------ | --------------- | -------------------------------------------------------- |
| User sends message in chat tab | UX → API        | Message POSTed to chat endpoint                          |
| Job created from message       | API → Data      | Job record created with correct agent binding            |
| LLM credential resolved        | Data → API      | Credential lookup succeeds for bound LLM provider (#444) |
| Agent executes turn            | API (internal)  | MCP tools invoked if needed, response generated          |
| Response returned to UI        | API → UX        | Assistant message displayed in chat (#431)               |
| Job detail populated           | Data → API → UX | Execution steps and errors visible in job panel (#437)   |

**Sibling surfaces:** Job list, agent activity stream, cost tracking.

---

## Flow 4: Telegram → Inbound → Job

| Step                      | Boundary       | Guarantee                                                                  |
| ------------------------- | -------------- | -------------------------------------------------------------------------- |
| Telegram webhook received | External → API | Webhook handler processes update                                           |
| Channel config resolved   | API → Data     | DB config applied to adapter, not just env vars (#430)                     |
| Inbound event created     | API → Data     | Event record created from Telegram message (#428)                          |
| Auth guard evaluated      | Data → API     | User authorized via grant; zero-grant = explicit deny with feedback (#448) |
| Job dispatched            | API → Data     | Job created and queued for execution                                       |

**Sibling surfaces:** Discord inbound (same pattern), channel management UI, agent auth settings.

---

## Flow 5: Credential → OAuth → Bind → Execute

| Step                             | Boundary        | Guarantee                                                     |
| -------------------------------- | --------------- | ------------------------------------------------------------- |
| Initiate OAuth flow for service  | UX → API        | OAuth redirect initiated for provider (Google, GitHub, Slack) |
| OAuth callback stores credential | API → Data      | Credential stored with correct `credential_class`             |
| Credential bound to agent        | API → Data      | `agent_credential_binding` created                            |
| Credential visible in UI         | Data → API → UX | Credential card shows connected state                         |
| Disconnect credential            | UX → API → Data | Binding + credential removed (#445)                           |
| Execute with credential          | Data → API      | Runtime resolves credential for tool execution                |

**Sibling surfaces:** Settings page (#446), credential list, agent configuration panel.

---

## Flow 6: Quarantine → Recovery

| Step                     | Boundary        | Guarantee                                                          |
| ------------------------ | --------------- | ------------------------------------------------------------------ |
| Agent execution fails    | API → Data      | Failure recorded, circuit breaker incremented                      |
| Config errors excluded   | API → Data      | Credential/config errors don't count toward circuit breaker (#450) |
| Circuit breaker trips    | Data → API      | Agent enters quarantine state                                      |
| Quarantine visible in UI | Data → API → UX | Agent badge shows quarantine status (not stale BOOTING #426)       |
| Recovery path available  | UX → API → Data | Manual reset API or auto-recovery after cooldown (#443)            |

**Sibling surfaces:** Agent list health indicators, operator event stream, dashboard summary.
