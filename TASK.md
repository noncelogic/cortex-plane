# Epic #212: Approve Agent Actions

## Context

The Approvals page (`/approvals`) shows approval requests but has dead buttons for approve/reject and the audit drawer. Backend routes exist in `packages/control-plane/src/routes/approval.ts`.

## What Needs to Happen

### 1. Approval List — Real Data

- Verify `GET /approvals` is called on mount with real data
- Show approval cards with risk level badges (P0-P3 from PR #190)
- Wire filter/sort controls to query params

### 2. Approve/Reject Actions

- Wire approve button to `POST /approvals/:id/decide` with `{ decision: "approved", reason?: string }`
- Wire reject button to `POST /approvals/:id/decide` with `{ decision: "rejected", reason?: string }`
- Add confirmation dialog for reject
- Show loading state during submission
- Refresh list after decision

### 3. Audit Trail Drawer

- Wire audit drawer to load data for selected approval
- Show decision history, timestamps, actors
- Wire to `GET /approvals/:id` for detailed data

### 4. Real-Time Updates (SSE)

- Wire SSE for real-time approval notifications
- New approval requests should appear without manual refresh
- Status changes should update in real-time

### 5. Approval Actions Component

Check `packages/dashboard/src/components/approvals/approval-actions.tsx` for dead buttons and wire them.

## Backend Routes (already exist in approval.ts)

- `POST /approvals/:agentId/request` — create approval request
- `POST /approvals/:id/decide` — approve or reject
- `GET /approvals` — list all approval requests
- `GET /approvals/:id` — get approval details

## Constraints

- Use existing `apiClient` patterns
- Add Zod schemas if needed
- Keep existing visual design
- Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test` before finishing
- When completely finished, run: openclaw system event --text "JOB_DONE:issue-212" --mode now
