# UI/API Contract Ledger: Dashboard Action Surface

Issue: #704

Audit scope: dashboard action client methods in `packages/dashboard/src/lib/api-client.ts` and their paired response schemas in `packages/dashboard/src/lib/schemas/actions.ts`, mapped to live control-plane routes.

| Dashboard method | Route                          | Request status | Response status | Notes                                                                                      |
| ---------------- | ------------------------------ | -------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `createAgentJob` | `POST /agents/:agentId/jobs`   | Match          | Match           | Route returns job row with extra fields; dashboard schema consumes the stable subset.      |
| `steerAgent`     | `POST /agents/:agentId/steer`  | Match          | Match           | Already aligned on camelCase response keys.                                                |
| `pauseAgent`     | `POST /agents/:agentId/pause`  | Match          | Fixed           | Schema updated from `agent_id` to `agentId`.                                               |
| `resumeAgent`    | `POST /agents/:agentId/resume` | Match          | Fixed           | Schema updated from `agent_id`/`from_checkpoint` to `agentId`/`fromCheckpoint`.            |
| `approveRequest` | `POST /approval/:id/decide`    | Compatible     | Match           | Dashboard sends an extra `decided_by` field; route ignores it and derives actor from auth. |
| `retryJob`       | `POST /jobs/:jobId/retry`      | Match          | Match           | Already aligned on `jobId`/`status`.                                                       |
| `syncMemory`     | `POST /memory/sync`            | Fixed          | Match           | Client request body updated from `agent_id` to `agentId`.                                  |
| `publishContent` | `POST /content/:id/publish`    | Match          | Fixed           | Schema updated to route shape: `id`, `status: "PUBLISHED"`, `publishedAt`.                 |
| `archiveContent` | `POST /content/:id/archive`    | Match          | Fixed           | Schema updated to route shape: `id`, `status: "ARCHIVED"`, `archivedAt`.                   |

Session contract follow-up (#724):

| Surface                    | Route                  | Status | Notes                                                                 |
| -------------------------- | ---------------------- | ------ | --------------------------------------------------------------------- |
| Session delete semantics   | `DELETE /sessions/:id` | Fixed  | Hard-delete contract (`action: "deleted"`, `deleted: true`) aligned |
| Dashboard session controls | Session list UI        | Fixed  | Labels and toasts use "Delete" semantics                            |

Guard coverage:

- `packages/dashboard/src/__tests__/schema-contract.test.ts` validates action fixtures against the dashboard schemas.
- `packages/dashboard/src/__tests__/chat.test.ts` validates delete-session response schema (`deleted: true`, `action: "deleted"`).
- `packages/control-plane/src/__tests__/session-routes.test.ts` and `chat-session-crud.test.ts` validate hard-delete semantics.
- `packages/dashboard/src/__tests__/api-client.test.ts` covers live control-plane pause/resume response shapes.
- `packages/dashboard/src/__tests__/memory.test.ts` verifies the `syncMemory` request body shape.
- `packages/dashboard/src/__tests__/pulse.test.ts` verifies publish/archive action response parsing.
