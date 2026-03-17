# Contributing to Cortex Plane

## Contract Tests

Any change that crosses a package boundary **must** include or update a
cross-boundary contract test. This ensures that the API response shapes
produced by the control-plane match the Zod schemas consumed by the dashboard.

### When to add a contract test

- Adding or changing a route handler response shape
- Modifying a dashboard Zod schema
- Changing service interfaces consumed by route handlers
- Adding new provider registrations or model catalogue entries

### How contract tests work

Contract tests live in two places:

1. **`packages/control-plane/src/__tests__/cross-boundary-contract.test.ts`** —
   spins up real Fastify route handlers (with mocked DB/services), calls actual
   endpoints, and validates responses against dashboard Zod schemas.

2. **`packages/dashboard/src/__tests__/schema-contract.test.ts`** —
   validates JSON fixtures against dashboard Zod schemas to catch schema drift.

### Running contract tests

```bash
cd packages/control-plane
npx vitest run src/__tests__/cross-boundary-contract.test.ts

cd packages/dashboard
npx vitest run src/__tests__/schema-contract.test.ts
```

CI blocks merge on any contract mismatch.

## Development Workflow

1. Create a branch from `main` using the pattern `feat/<issue-number>-<slug>`
2. Implement your changes with tests
3. Run `npx vitest run` in `packages/control-plane/` to verify all tests pass
4. Run `npx eslint src/` for linting
5. Run `npm run typecheck` for type checking
6. Open a PR targeting `main`
