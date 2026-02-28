# Epic #215: Content Pipeline (Pulse)

## Context

The Pulse page (`/pulse`) is a content pipeline board where agents produce drafts that users review, publish, or archive. Currently has zero interactivity — no onClick handlers at all. Backend routes exist in `packages/control-plane/src/routes/dashboard.ts`.

## What Needs to Happen

### 1. Content List — Real Data

- Wire the page to load content from `GET /content` (with status/limit query params)
- Show content cards with status badges (draft/published/archived)
- Group by status in pipeline columns if kanban layout exists

### 2. Publish Action

- Wire publish button to `POST /content/:id/publish`
- Show confirmation
- Refresh list after publish

### 3. Archive Action

- Wire archive button to `POST /content/:id/archive`
- Refresh list after archive

### 4. Filter Controls

- Wire filter buttons to query params (status, date range, agent)
- Wire search/sort controls

### 5. Content Detail View

- Click on content card should show full content
- Show metadata: agent, created date, word count, etc.

## Backend Routes (already exist in dashboard.ts)

- `GET /content` — list content (with status/limit query params)
- `POST /content/:id/publish` — publish content
- `POST /content/:id/archive` — archive content

## Constraints

- Use existing `apiClient` patterns
- Add Zod schemas if needed (check `packages/dashboard/src/lib/schemas/content.ts`)
- Keep existing visual design
- Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test` before finishing
- When completely finished, run: openclaw system event --text "JOB_DONE:issue-215" --mode now
