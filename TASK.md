# Epic #213: Memory Explorer

## Context

The Memory page (`/memory`) has dead search, sync, document viewer, and editor buttons. Also has a bug (#216): initial load sends `*` as query which backend tries to parse as UUID → crash.

## What Needs to Happen

### 1. Fix #216 — UUID Parse Error on Load

- The page sends `*` as default search query on mount
- Backend `GET /memory/search` tries to use it as UUID → Postgres rejects
- Fix: either don't send initial query (show empty state) or handle wildcard/empty gracefully

### 2. Memory Search

- Wire search input to `GET /memory/search?query=...`
- Show results in the results panel
- Handle empty results gracefully

### 3. Sync Status & Trigger

- Wire sync button to `POST /memory/sync`
- Show sync status indicator (syncing/synced/error)
- Component at `packages/dashboard/src/components/memory/sync-status.tsx`

### 4. Document Viewer

- Wire document viewer at `packages/dashboard/src/components/memory/document-viewer.tsx`
- Edit/delete buttons need onClick handlers
- View button should load full document content

### 5. Memory Editor

- Wire save button in `packages/dashboard/src/components/memory/memory-editor.tsx`
- Should persist edits via appropriate API call

### 6. Related Panel

- Wire related memories panel at `packages/dashboard/src/components/memory/related-panel.tsx`
- Click on related item should navigate/load that memory

## Backend Routes (already exist in dashboard.ts)

- `GET /memory/search` — search memories (query, limit params)
- `POST /memory/sync` — trigger memory sync

## Constraints

- Use existing `apiClient` patterns
- Add Zod schemas if needed
- Keep existing visual design
- Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test` before finishing
- When completely finished, run: openclaw system event --text "JOB_DONE:issue-213" --mode now
