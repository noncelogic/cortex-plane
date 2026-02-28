# Issue #233: Wire execution backend — agent receives chat → spawns jobs

## Goal
When a chat message arrives via Telegram/Discord, the message dispatch handler must:
1. Find the bound agent + session (already done in `message-dispatch.ts`)
2. Create a `job` row in the database
3. Enqueue an `agent_execute` Graphile Worker task
4. Stream the agent's text response back to the chat channel

## Context — What Already Exists
The heavy lifting is done. This ticket is **glue code** connecting existing pieces:

### Execution pipeline (complete)
- `packages/control-plane/src/worker/tasks/agent-execute.ts` — Full job lifecycle: SCHEDULED→RUNNING→COMPLETED, streams events, handles approval gates, memory extraction, retries, circuit breaker routing
- `packages/shared/src/backends/types.ts` — `ExecutionBackend` interface, `ExecutionTask`, `ExecutionResult`, streaming `OutputEvent`
- `packages/control-plane/src/backends/` — `ClaudeCodeBackend`, `HttpLlmBackend`, `EchoBackend`
- `packages/control-plane/src/worker/index.ts` — Graphile Worker runner with `agent_execute` task registered
- `packages/control-plane/src/app.ts` — `workerUtils.addJob('agent_execute', { jobId })` already wired (lines 166, 186)

### Message routing (complete)
- `packages/control-plane/src/channels/message-dispatch.ts` — Resolves agent binding, finds/creates session, but currently just **logs** instead of creating a job
- `packages/control-plane/src/channels/agent-channel-service.ts` — Agent↔channel binding lookups
- `packages/control-plane/src/channels/router-db.ts` — User resolution for routed messages

### What's missing (this ticket)
The dispatch handler needs to:
1. Create a `job` row when a message arrives
2. Enqueue `agent_execute` via Graphile Worker
3. Subscribe to the job's output events and relay text responses back to the chat channel

## Requirements

### 1. Modify `message-dispatch.ts`
Replace the `logger.info("Message dispatched to agent session")` with:

```typescript
// 1. Load agent to get model_config
const agent = await db.selectFrom('agent').selectAll()
  .where('id', '=', agentId).executeTakeFirstOrThrow()

// 2. Create job row
const job = await db.insertInto('job').values({
  agent_id: agentId,
  session_id: session.id,
  type: 'CHAT_RESPONSE',
  status: 'SCHEDULED',
  payload: {
    prompt: routed.message.text,
    goalType: 'research',  // chat messages are research/response, not code_edit
    conversationHistory: [],  // future: load from session buffer
  },
  priority: 'NORMAL',
  max_attempts: 3,
  timeout_seconds: 120,
}).returning('id').executeTakeFirstOrThrow()

// 3. Enqueue worker task
await enqueueJob(job.id)
```

### 2. Add `enqueueJob` to dispatch deps
`createMessageDispatch` needs access to `workerUtils.addJob`. Add to deps:
```typescript
export interface MessageDispatchDeps {
  db: Kysely<Database>
  agentChannelService: AgentChannelService
  router: MessageRouter
  enqueueJob: (jobId: string) => Promise<void>  // NEW
  logger?: { ... }
}
```

### 3. Wire `enqueueJob` in `index.ts`
In `index.ts`, the dispatch is created before `buildApp()` where `workerUtils` lives. Two approaches:
- **Option A**: Move dispatch creation inside `buildApp()` so it has access to `workerUtils`
- **Option B**: Create a deferred callback that `buildApp()` resolves later
- **Option C** (simplest): Import `makeWorkerUtils` directly in `index.ts` and pass to dispatch

Choose the simplest approach that doesn't create circular dependencies.

### 4. Response relay — subscribe to job output and reply via chat
After enqueuing the job, the dispatch needs to relay the agent's text response back to the chat. Options:
- **Option A (recommended)**: Add a completion callback that the `agent-execute` task invokes when done. The callback calls `router.send()`.
- **Option B**: The dispatch polls for job completion (bad — adds latency).
- **Option C**: The dispatch subscribes to SSE events for this agent and relays text events.

For Option A, add a `responseCallback` to `AgentExecutePayload`:
```typescript
// In message-dispatch.ts, after enqueuing:
// Subscribe to job completion and send response
onJobComplete(job.id, async (result) => {
  if (result.summary) {
    await router.send(channelType, chatId, { text: result.summary })
  }
})
```

Implementation: register a listener on the SSE manager or use pg LISTEN/NOTIFY.

### 5. Conversation history (stretch goal)
Load previous messages from the session buffer (JSONL) to provide context:
```typescript
const history = await loadSessionHistory(db, session.id, { limit: 20 })
payload.conversationHistory = history
```

### 6. Tests
- Unit test: dispatch creates a job row and calls `enqueueJob`
- Unit test: dispatch sends "no agent" message when no binding exists (already tested)
- Unit test: response relay sends text back to chat channel
- Integration test: full flow with EchoBackend — message in → job created → echo response → reply sent

## Files to modify
- `packages/control-plane/src/channels/message-dispatch.ts` — main changes
- `packages/control-plane/src/index.ts` — wire `enqueueJob` into dispatch
- `packages/control-plane/src/app.ts` — possibly expose `workerUtils` for dispatch

## Files to check first
- `packages/control-plane/src/worker/tasks/agent-execute.ts` — understand job lifecycle
- `packages/control-plane/src/backends/echo-backend.ts` — simplest backend for testing
- `packages/control-plane/src/streaming/manager.ts` — SSE broadcast mechanism
- `packages/control-plane/src/db/types.ts` — `Job` table schema, column names
- `packages/shared/src/backends/types.ts` — `ExecutionTask`, `ExecutionResult`
- `packages/shared/src/channels/router.ts` — `MessageRouter.send()` signature

## Constraints
- Do NOT modify backend implementations — they work
- Do NOT modify the `agent-execute` worker task internals — it works
- Keep the EchoBackend as the default for testing (no API keys needed)
- `job.type` should be `'CHAT_RESPONSE'` to distinguish from API-created jobs
- Run `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` before committing
- Use conventional commit: `feat(control-plane): wire chat message dispatch to execution backend`

When completely finished, run: `openclaw system event --text "JOB_DONE:issue-233" --mode now`
