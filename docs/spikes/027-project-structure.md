# Spike #27 — Project Structure & Tooling

**Status:** Accepted
**Date:** 2026-02-23
**Author:** Cortex Plane Team

---

## Table of Contents

1. [Context](#context)
2. [Decision 1: Monorepo vs Single Package](#decision-1-monorepo-vs-single-package)
3. [Decision 2: Package Manager](#decision-2-package-manager)
4. [Decision 3: TypeScript Config](#decision-3-typescript-config)
5. [Decision 4: ORM / Query Builder](#decision-4-orm--query-builder)
6. [Decision 5: HTTP Framework](#decision-5-http-framework)
7. [Decision 6: Logging](#decision-6-logging)
8. [Decision 7: Config Management](#decision-7-config-management)
9. [Decision 8: Docker Base Image](#decision-8-docker-base-image)
10. [Artifact: Directory Structure](#artifact-directory-structure)
11. [Artifact: Package.json Skeleton](#artifact-packagejson-skeleton)
12. [Artifact: tsconfig.json](#artifact-tsconfigjson)
13. [Artifact: Dockerfile](#artifact-dockerfile)
14. [Artifact: docker-compose.yml](#artifact-docker-composeyml)
15. [Artifact: ESLint + Prettier Config](#artifact-eslint--prettier-config)

---

## Context

Cortex Plane is a greenfield TypeScript platform for autonomous agent orchestration on k3s. The system comprises:

- **Control plane** — stateless Node.js service; all state in PostgreSQL
- **Graphile Worker** — durable job processing for agent workflows (core dependency)
- **Dashboard** — Next.js web UI for monitoring and management
- **Channel adapters** — Telegram, Discord (future: Slack, etc.)
- **Qdrant** — vector database for agent memory
- **Agent pods** — spawned as k8s jobs/pods by the control plane

### Starting Point: noncelogic/boilerplate

The project scaffolds from the existing [noncelogic/boilerplate](https://github.com/noncelogic/boilerplate) ("Concept Car Scaffolding"), which provides a battle-tested monorepo foundation:

- pnpm + Turborepo workspace
- Prisma in `packages/database`
- ESLint v9 flat config, Vitest, Husky, lint-staged
- `apps/` + `packages/` monorepo structure
- CI workflow, pre-commit hooks

**Pruning required:** The boilerplate includes frontend-heavy packages (forms, feedback, screenshots, state, UI) that aren't needed initially. The initial scaffold strips these down to:

- `packages/database` (Prisma → repurposed for app schema, coexisting with Graphile Worker)
- `packages/shared` (types, constants)
- `packages/control-plane` (the core engine — single process initially)
- `apps/web` → `apps/dashboard` (Next.js, deferred to M3)

**Why monorepo despite single process today:** The core engine is one process now, but the architecture is designed for extensibility. Channel adapters, execution backends, and skills will be published as npm packages. The monorepo structure supports this evolution without a costly restructure later.

### Hard Constraints

| Constraint                  | Implication                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| k3s on ARM64 + x64          | Every dependency must build on both architectures                           |
| Stateless control plane     | No in-memory state; PostgreSQL is the single source of truth                |
| Graphile Worker is core     | ORM/migration choice must not conflict with Worker's schema management      |
| Hot reload in dev           | Watch mode required; fast feedback loop is non-negotiable                   |
| Health endpoints from day 1 | `/healthz` (liveness), `/readyz` (readiness — DB connected, Worker running) |

---

## Decision 1: Monorepo vs Single Package

### Options Evaluated

| Criterion                    | pnpm Workspaces (bare)           | Turborepo                               | Nx                                           |
| ---------------------------- | -------------------------------- | --------------------------------------- | -------------------------------------------- |
| Setup complexity             | Low — `pnpm-workspace.yaml` only | Low — thin layer on pnpm                | High — generators, plugins, project graph    |
| Build orchestration          | Manual (`--filter`)              | Task pipeline with topological ordering | Full dependency graph + affected commands    |
| Remote caching               | No                               | Yes (Vercel or self-hosted)             | Yes (Nx Cloud or self-hosted)                |
| ARM64 support                | Native (pnpm is JS)              | Native (JS-based)                       | Native (JS-based)                            |
| Learning curve               | Minimal                          | Low                                     | Moderate-to-high                             |
| Lock-in                      | None                             | Low (just remove turbo.json)            | Moderate (nx.json, project.json per package) |
| Right-sized for ~5 packages? | Yes                              | Yes                                     | Overkill                                     |

### Decision: **pnpm Workspaces + Turborepo**

**Rationale:**

- We have ~5 packages: `@cortex/control-plane`, `@cortex/dashboard`, `@cortex/shared`, `@cortex/adapter-telegram`, `@cortex/adapter-discord`. This is small enough that bare pnpm workspaces would work, but Turborepo adds genuine value at near-zero cost:
  - **Topological build ordering** — `@cortex/shared` must build before consumers. Turborepo handles this automatically via `turbo.json` pipeline definitions. Without it, you're writing manual `--filter` chains.
  - **Local caching** — rebuilding unchanged packages is wasteful even at this scale. Turborepo caches task outputs by content hash. Free speedup.
  - **Parallel execution** — `turbo run lint test --parallel` across all packages with a single command.
- Turborepo is a thin layer: one `turbo.json` file. If it ever becomes a problem, rip it out in 10 minutes.
- Nx is rejected: the project graph, generators, and plugin system are designed for 50+ package monorepos. For 5 packages, it adds complexity without proportional value.

---

## Decision 2: Package Manager

### Options Evaluated

| Criterion          | pnpm                                        | Bun                                                       |
| ------------------ | ------------------------------------------- | --------------------------------------------------------- |
| Maturity           | Production-proven since 2017                | Runtime stable, package manager less battle-tested        |
| ARM64 support      | Native — pure JS                            | Native — Zig-compiled binary available for ARM64          |
| k3s/Docker compat  | `corepack enable && pnpm install`           | Requires Bun binary in image; not in official Node images |
| Workspace support  | First-class (`pnpm-workspace.yaml`)         | Supported but less ecosystem integration                  |
| Lockfile stability | `pnpm-lock.yaml` — mature, well-understood  | `bun.lockb` — binary format, harder to review in PRs      |
| Turborepo compat   | First-class support                         | Supported but Turborepo docs assume pnpm/npm/yarn         |
| Node.js compat     | Is a package manager for Node.js            | Is a runtime + package manager; we run on Node.js         |
| Speed              | Fast (content-addressable store, hardlinks) | Fastest install times                                     |

### Decision: **pnpm**

**Rationale:**

- We are running **Node.js 24** as our runtime, not Bun. Using Bun as a package manager while running Node.js creates a split-brain situation: Bun resolves modules differently than Node.js in edge cases (especially with ESM).
- pnpm's strict node_modules structure (no phantom dependencies) catches real bugs that flat `node_modules` hides. This matters when deploying to containers where the dependency tree must be deterministic.
- pnpm is the default recommendation for Turborepo. The integration is seamless.
- Bun's binary lockfile cannot be meaningfully reviewed in pull requests. For a "rigorous, explicit" project, readable lockfiles matter.
- pnpm's content-addressable store means disk usage is efficient even in a monorepo with shared dependencies.

---

## Decision 3: TypeScript Config

### Options Evaluated

| Criterion                        | Decision                                         | Rationale                                                                                        |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Strict mode                      | **Yes — `"strict": true`**                       | Non-negotiable for a new project. Catches nullability bugs, forces explicit types at boundaries. |
| Module system                    | **ESM-only (`"module": "nodenext"`)**            | Node.js 24 has stable ESM support. CJS is legacy. Graphile Worker supports ESM.                  |
| Target                           | **`"target": "es2024"`**                         | Node.js 24 supports all ES2023 features natively. No transpilation overhead.                     |
| Path aliases                     | **Yes — `@cortex/*` maps to workspace packages** | pnpm workspaces handle resolution; `paths` in tsconfig provides editor support.                  |
| Shared base config               | **Yes — `tsconfig.base.json` at root**           | DRY. Per-package configs extend the base with their own `outDir`, `rootDir`, `references`.       |
| `verbatimModuleSyntax`           | **Yes**                                          | Forces `import type` for type-only imports. Prevents runtime import of type-only modules.        |
| `skipLibCheck`                   | **`true`**                                       | Speeds up compilation. We trust our dependencies' types.                                         |
| `declaration` + `declarationMap` | **Yes for shared packages**                      | Enables Go-to-Definition across packages in the monorepo.                                        |
| `composite` + project references | **Yes**                                          | Enables `tsc --build` for incremental cross-package compilation.                                 |

### Decision: **Strict ESM with shared base config and project references**

See [Artifact: tsconfig.json](#artifact-tsconfigjson) for the full config.

---

## Decision 4: ORM / Query Builder

### Options Evaluated

| Criterion              | Drizzle ORM                                         | Kysely                                    | Raw pg (`node-postgres`)                 |
| ---------------------- | --------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Type safety            | Full — schema-as-code, inferred types               | Full — type-safe query builder            | Manual — hand-written interfaces         |
| Query style            | ORM-like API + raw SQL escape hatch                 | SQL-like builder (feels like writing SQL) | Raw SQL strings                          |
| Migration tooling      | `drizzle-kit` — generates SQL from schema diffs     | Own migration system or third-party       | Manual SQL files                         |
| Graphile Worker compat | **Conflict risk** — Drizzle wants to own the schema | **Good** — Kysely doesn't manage schema   | **Perfect** — no abstraction to conflict |
| Learning curve         | Moderate (Drizzle API + drizzle-kit)                | Low (if you know SQL)                     | None                                     |
| Schema introspection   | Can pull from DB, but prefers push-based            | Can generate types from DB                | N/A                                      |
| Maturity               | v0.x — still evolving, breaking changes occur       | v0.x — API stable, widely used            | Decades-old, battle-proven               |

### Decision: **Kysely**

**Rationale:**

This decision is driven almost entirely by the Graphile Worker constraint.

**Graphile Worker manages its own schema.** It creates and migrates the `graphile_worker` schema automatically when it starts. It uses `node-postgres` (pg) directly. Any ORM that tries to "own" the database schema creates friction:

- **Drizzle** is push-based by default: you define the schema in TypeScript, and `drizzle-kit push` applies it. This conflicts with Graphile Worker's self-managed schema. You'd have to carefully exclude `graphile_worker.*` from Drizzle's purview, and any misconfig could drop Worker's tables. The risk is not theoretical — `drizzle-kit push` has a `--force` flag that drops and recreates. Too dangerous.

- **Raw pg** is safe but gives up type safety. For a project with complex domain models (workflows, agent state, channel configs), writing raw SQL with hand-typed interfaces is error-prone and slow.

- **Kysely** is the sweet spot:
  - It's a **query builder**, not an ORM. It doesn't try to manage the schema. You bring your own migrations.
  - It produces **fully type-safe queries** from TypeScript interfaces. The type inference is excellent — it catches column name typos, wrong types in WHERE clauses, and missing joins at compile time.
  - We use **plain SQL migration files** (managed by a simple runner or `kysely-migration-cli`) for our application tables. Graphile Worker manages its own tables. No conflict.
  - It uses `pg` (node-postgres) under the hood — the same driver Graphile Worker uses. **One connection pool, shared.** No driver mismatch.
  - The query builder syntax reads like SQL, which makes code review straightforward. No magic.

**Migration strategy:**

- Application tables: Kysely's built-in migration system (`FileMigrationProvider`) with numbered SQL files in `migrations/`.
- Graphile Worker tables: Managed automatically by Worker on startup. We never touch them.
- Both share the same PostgreSQL database but operate in separate schemas (`public` for app, `graphile_worker` for Worker).

---

## Decision 5: HTTP Framework

### Options Evaluated

| Criterion              | Fastify                                             | Hono                                          | Express                          |
| ---------------------- | --------------------------------------------------- | --------------------------------------------- | -------------------------------- |
| Performance            | ~75k req/s (native JSON serializer)                 | ~85k req/s (lightweight core)                 | ~15k req/s (slowest)             |
| TypeScript support     | First-class, generic type parameters                | First-class, built for TS                     | Bolted on via `@types/express`   |
| SSE support            | Via `@fastify/sse` or raw response                  | Built-in `streamSSE` helper                   | Manual — write to `res`          |
| WebSocket support      | `@fastify/websocket` (mature)                       | `hono/ws` adapter (newer)                     | `ws` + `express-ws` (clunky)     |
| Plugin ecosystem       | 100+ official plugins                               | Growing but smaller                           | Largest (but many unmaintained)  |
| JSON Schema validation | Built-in (Ajv integration)                          | Via `@hono/zod-validator`                     | Manual (express-validator, etc.) |
| Encapsulation          | Plugin system with scoped contexts                  | Middleware only                               | Middleware only                  |
| Maturity on Node.js    | Native Node.js framework                            | Originally for edge; Node adapter added later | 10+ years                        |
| Logging integration    | Built-in Pino integration                           | Manual                                        | Manual                           |
| Hook system            | Lifecycle hooks (onRequest, preSerialization, etc.) | Middleware only                               | Middleware only                  |

### Decision: **Fastify**

**Rationale:**

- **Native Node.js framework.** Hono was designed for edge runtimes (Cloudflare Workers, Deno, Bun) and added Node.js support via an adapter. Fastify was built for Node.js from the ground up. Since we're running Node.js 24 on k3s, Fastify is the natural fit. Hono's Node.js adapter adds an abstraction layer we don't need.

- **Built-in Pino logging.** Fastify instantiates a Pino logger and threads it through every request. We get structured JSON logging (Decision 6) with zero configuration. Hono requires wiring this up manually.

- **JSON Schema validation is built-in.** Define route schemas, get automatic request validation and OpenAPI-compatible documentation. Hono requires a Zod plugin; Fastify does it natively with Ajv (faster than Zod for validation).

- **Plugin encapsulation.** Fastify's plugin system provides scoped contexts — a plugin can register its own decorators, hooks, and routes without leaking into the global scope. This is perfect for our architecture: the health check plugin, the SSE streaming plugin, the WebSocket plugin, and the API routes plugin are all isolated.

- **SSE and WebSocket are well-supported.** `@fastify/websocket` is mature. For SSE, we write to the raw Node.js response with proper headers — Fastify's `reply.raw` gives us access without fighting the framework.

- **Express is rejected** because it's slow, lacks native TypeScript support, and its middleware model is a flat chain with no encapsulation. Express v5 has been in beta for years.

---

## Decision 6: Logging

### Options Evaluated

| Criterion             | Pino                                                  | Winston                                       |
| --------------------- | ----------------------------------------------------- | --------------------------------------------- |
| Performance           | ~5x faster (10k+ msg/s)                               | Slower due to transform streams               |
| Output format         | Structured JSON by default                            | Configurable (JSON, printf, custom)           |
| k8s/Loki compat       | Excellent — JSON logs are native to k8s log pipelines | Good — needs JSON transport configured        |
| Fastify integration   | Built-in — Fastify uses Pino natively                 | Requires `fastify-winston` (community plugin) |
| Child loggers         | Lightweight (inherits bindings, no clone)             | Heavier (creates new logger instance)         |
| Pretty printing (dev) | `pino-pretty` CLI pipe                                | Built-in format options                       |
| Log levels            | Standard (trace, debug, info, warn, error, fatal)     | Custom levels supported                       |
| Async logging         | Yes — uses `sonic-boom` for async writes              | Sync by default                               |

### Decision: **Pino**

**Rationale:**

This is the easiest decision in the document. Pino wins on every axis that matters:

1. **Fastify uses Pino natively.** Choosing Winston would mean replacing the built-in logger, adding a dependency, and losing Fastify's automatic request logging. Choosing Pino means zero configuration — `fastify({ logger: true })` gives us structured JSON request logs with request ID, response time, and status code out of the box.

2. **Performance.** In a system processing agent workflow events at high throughput, logging cannot be a bottleneck. Pino's async write path (via `sonic-boom`) and minimal serialization overhead make it 5x faster than Winston. This is measured, not theoretical.

3. **Structured JSON is the native format.** In k8s, logs go to stdout, are collected by Fluentd/Fluent Bit/Promtail, and shipped to Loki or Elasticsearch. JSON logs are parsed without custom regex patterns. Pino outputs JSON by default. Winston can, but it requires explicit configuration.

4. **Child loggers for context.** `logger.child({ workflowId, agentId })` creates a child logger that automatically includes those fields in every log line. Cheap to create, no cloning overhead. Essential for tracing agent workflows through logs.

**Dev experience:** `pino-pretty` is piped in development only (`node app.js | pino-pretty`). In production, raw JSON goes to stdout. No conditional formatting in application code.

---

## Decision 7: Config Management

### Options Evaluated

| Criterion       | dotenv + manual validation   | convict                   | @fastify/env (envSchema) | Custom Zod/AJV            |
| --------------- | ---------------------------- | ------------------------- | ------------------------ | ------------------------- |
| Type safety     | None                         | Moderate (convict schema) | Ajv JSON Schema          | Full (Zod infers types)   |
| Validation      | Manual `if (!process.env.X)` | Built-in, runs on load    | Built-in Ajv validation  | Zod `.parse()` on startup |
| Default values  | In code                      | In schema                 | In JSON Schema           | In Zod schema             |
| Secret handling | `.env` file                  | `.env` + config files     | `.env` via `dotenv`      | `.env` via `dotenv`       |
| Complexity      | Low but fragile              | Moderate                  | Low (Fastify plugin)     | Low-moderate              |
| Fail-fast       | Only if you write checks     | Yes — throws on invalid   | Yes — throws on invalid  | Yes — throws on invalid   |

### Decision: **`@fastify/env` (Ajv-based env validation)**

**Rationale:**

- **Fastify-native.** `@fastify/env` is an official Fastify plugin. It validates environment variables against a JSON Schema on startup and decorates the Fastify instance with typed config. One plugin registration, done.

- **Fail-fast by design.** If `DATABASE_URL` is missing or `PORT` is not a number, the server refuses to start with a clear error message. No silent misconfiguration.

- **JSON Schema consistency.** We already use JSON Schema for route validation (Fastify + Ajv). Using the same schema language for config means one mental model, not two.

- **Simple `.env` for development.** `@fastify/env` integrates with `dotenv`. In production on k3s, we inject env vars via ConfigMaps and Secrets — no `.env` file in the container.

- **convict is rejected** because it's a large dependency with its own schema format that doesn't align with anything else in our stack. It's over-engineered for our needs.

- **Raw dotenv is rejected** because it provides zero validation. Every project that starts with "just use dotenv" eventually writes ad-hoc validation scattered across the codebase. We do it once, at startup, with a schema.

**Config schema lives at:** `packages/control-plane/src/config.ts` — a single JSON Schema object that documents every environment variable the service needs.

---

## Decision 8: Docker Base Image

### Options Evaluated

| Criterion                  | `node:24-slim` (Debian bookworm) | `node:24-alpine` (musl libc)                                           |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Image size                 | ~200MB                           | ~130MB                                                                 |
| ARM64 support              | Excellent — official multi-arch  | Good — but musl edge cases                                             |
| Native npm deps            | glibc — everything works         | musl — some packages need `--build-from-source`                        |
| Playwright compat          | Supported (with apt deps)        | **Not supported** — Playwright docs explicitly say "do not use Alpine" |
| Security updates           | Debian security team             | Alpine security team                                                   |
| Debug tooling              | `apt-get install` anything       | `apk add` — smaller package repo                                       |
| `sharp` / image processing | Works out of the box             | Requires `vips-dev` and rebuild                                        |
| glibc compat               | Native                           | musl — occasional segfaults with native addons                         |

### Decision: **`node:24-slim`**

**Rationale:**

The 70MB image size difference is irrelevant compared to the operational cost of musl libc compatibility issues:

1. **Playwright explicitly does not support Alpine.** If we ever need Playwright for agent browser automation (scraping, testing), Alpine is a dead end. Even if we don't need it today, choosing Alpine today means a base image migration later. `node:24-slim` keeps this option open at no cost.

2. **Native npm packages.** Some dependencies use native addons compiled against glibc. On Alpine (musl), these either need to be rebuilt from source (slow, may fail) or require compatibility layers. `node:24-slim` eliminates this entire class of build problems.

3. **ARM64 reliability.** While Alpine supports ARM64, the combination of musl + ARM64 + native addons is the most failure-prone build matrix in the Node.js ecosystem. Debian on ARM64 is the most tested path.

4. **70MB is nothing.** In a k3s cluster where we're running PostgreSQL, Qdrant, and agent pods, saving 70MB per control plane image is meaningless. Image pulls are cached. Build time and runtime reliability matter more.

**Multi-stage build** minimizes final image size regardless — dev dependencies and build tools are in the builder stage, not the runtime stage. See [Artifact: Dockerfile](#artifact-dockerfile).

---

## Artifact: Directory Structure

```
cortex-plane/
├── .github/
│   └── workflows/
│       └── ci.yml
├── packages/
│   ├── control-plane/              # Main orchestrator service
│   │   ├── src/
│   │   │   ├── index.ts            # Entry point — starts Fastify + Graphile Worker
│   │   │   ├── app.ts              # Fastify app factory (testable without listen)
│   │   │   ├── config.ts           # Env schema (JSON Schema for @fastify/env)
│   │   │   ├── db/
│   │   │   │   ├── pool.ts         # pg Pool creation + health check
│   │   │   │   └── types.ts        # Kysely Database interface (generated/maintained)
│   │   │   ├── routes/
│   │   │   │   ├── health.ts       # /healthz, /readyz
│   │   │   │   ├── workflows.ts    # Workflow CRUD + trigger
│   │   │   │   ├── agents.ts       # Agent lifecycle management
│   │   │   │   └── events.ts       # SSE endpoint for workflow events
│   │   │   ├── plugins/
│   │   │   │   ├── db.ts           # Fastify plugin: decorates with db/kysely
│   │   │   │   ├── worker.ts       # Fastify plugin: Graphile Worker lifecycle
│   │   │   │   └── sse.ts          # Fastify plugin: SSE response helper
│   │   │   ├── tasks/              # Graphile Worker task handlers
│   │   │   │   ├── run-agent.ts
│   │   │   │   ├── process-message.ts
│   │   │   │   └── index.ts        # Task registry (exports taskList)
│   │   │   └── services/
│   │   │       ├── workflow.ts      # Workflow orchestration logic
│   │   │       ├── agent.ts         # Agent pod management (k8s API)
│   │   │       └── memory.ts        # Qdrant client wrapper
│   │   ├── migrations/
│   │   │   ├── 001_initial.ts       # Kysely migration files
│   │   │   └── ...
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── dashboard/                   # Next.js web UI
│   │   ├── src/
│   │   │   ├── app/                 # Next.js App Router
│   │   │   └── ...
│   │   ├── package.json
│   │   ├── next.config.ts
│   │   └── tsconfig.json
│   ├── shared/                      # Shared types, constants, utils
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   ├── workflow.ts      # Workflow, Step, AgentConfig types
│   │   │   │   ├── events.ts        # SSE event schemas
│   │   │   │   └── index.ts
│   │   │   ├── constants.ts         # Shared constants (task names, etc.)
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── adapter-telegram/            # Telegram channel adapter
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── adapter-discord/             # Discord channel adapter
│       ├── src/
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
├── docker/
│   ├── Dockerfile.control-plane
│   └── Dockerfile.dashboard
├── turbo.json
├── pnpm-workspace.yaml
├── package.json                     # Root — workspace scripts, devDependencies
├── tsconfig.base.json               # Shared TypeScript config
├── .eslintrc.cjs                    # Shared ESLint config
├── .prettierrc                      # Prettier config
├── docker-compose.yml               # Dev environment
├── .env.example                     # Documented env vars
├── .gitignore
└── docs/
    └── spikes/
        └── 027-project-structure.md # This document
```

---

## Artifact: Package.json Skeleton

### Root `package.json`

```jsonc
{
  "name": "cortex-plane",
  "private": true,
  "packageManager": "pnpm@9.15.4",
  "engines": {
    "node": ">=24.0.0",
  },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "lint": "turbo run lint",
    "lint:fix": "turbo run lint:fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "clean": "turbo run clean",
    "db:migrate": "pnpm --filter @cortex/control-plane run db:migrate",
    "db:migrate:create": "pnpm --filter @cortex/control-plane run db:migrate:create",
    "docker:up": "docker compose up -d",
    "docker:down": "docker compose down",
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^10.0.0",
    "prettier": "^3.4.0",
    "turbo": "^2.4.0",
    "typescript": "^5.7.0",
  },
}
```

### `packages/control-plane/package.json`

```jsonc
{
  "name": "@cortex/control-plane",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc --build",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "clean": "rm -rf dist",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:migrate:create": "tsx src/db/create-migration.ts",
  },
  "dependencies": {
    "@cortex/shared": "workspace:*",
    "@fastify/env": "^5.0.0",
    "@fastify/websocket": "^11.0.0",
    "@qdrant/js-client-rest": "^1.12.0",
    "fastify": "^5.2.0",
    "graphile-worker": "^0.16.0",
    "kysely": "^0.27.0",
    "pg": "^8.13.0",
    "pino": "^9.6.0",
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "pino-pretty": "^13.0.0",
    "tsx": "^4.19.0",
    "vitest": "^3.0.0",
  },
}
```

### `packages/shared/package.json`

```jsonc
{
  "name": "@cortex/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts",
    },
  },
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix",
    "clean": "rm -rf dist",
  },
  "devDependencies": {},
}
```

### `packages/dashboard/package.json`

```jsonc
{
  "name": "@cortex/dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "next build",
    "dev": "next dev --port 3100",
    "start": "next start",
    "lint": "next lint",
    "lint:fix": "next lint --fix",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf .next",
  },
  "dependencies": {
    "@cortex/shared": "workspace:*",
    "next": "^15.2.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.0",
  },
}
```

---

## Artifact: tsconfig.json

### `tsconfig.base.json` (Root)

```jsonc
{
  "compilerOptions": {
    // Language & Runtime
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2024"],

    // Strictness — non-negotiable
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,

    // Emit
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,

    // Performance
    "skipLibCheck": true,
    "incremental": true,
    "composite": true,
  },
}
```

### `packages/control-plane/tsconfig.json`

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
  },
  "include": ["src"],
  "references": [{ "path": "../shared" }],
}
```

### `packages/shared/tsconfig.json`

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
  },
  "include": ["src"],
}
```

### `packages/dashboard/tsconfig.json`

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    // Next.js overrides — it has its own module resolution
    "target": "es2024",
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "noEmit": true,

    // Next.js specific
    "isolatedModules": true,
    "resolveJsonModule": true,
    "allowJs": true,

    // Relax for Next.js compat
    "verbatimModuleSyntax": false,
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "incremental": true,

    // Path alias for local imports
    "paths": {
      "@/*": ["./src/*"],
    },
    "plugins": [{ "name": "next" }],
  },
  "include": ["src", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"],
  "references": [{ "path": "../shared" }],
}
```

---

## Artifact: Dockerfile

### `docker/Dockerfile.control-plane`

```dockerfile
# ==============================================================================
# Stage 1: Install dependencies
# ==============================================================================
FROM node:24-slim AS deps

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config first (cache layer)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/control-plane/package.json ./packages/control-plane/
COPY packages/shared/package.json ./packages/shared/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# ==============================================================================
# Stage 2: Build
# ==============================================================================
FROM node:24-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/control-plane/package.json ./packages/control-plane/
COPY packages/shared/package.json ./packages/shared/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/control-plane/ ./packages/control-plane/

# Build shared first, then control-plane (turbo handles ordering)
RUN pnpm turbo run build --filter=@cortex/control-plane...

# ==============================================================================
# Stage 3: Runtime
# ==============================================================================
FROM node:24-slim AS runtime

# Security: run as non-root
RUN groupadd -r cortex && useradd -r -g cortex -m cortex

# Install tini for proper signal handling (PID 1 problem)
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/control-plane/node_modules ./packages/control-plane/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

# Copy built artifacts from builder stage
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/control-plane/dist ./packages/control-plane/dist

# Copy package.json files (needed for module resolution)
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/control-plane/package.json ./packages/control-plane/
COPY --from=builder /app/pnpm-workspace.yaml ./

# Switch to non-root user
USER cortex

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/healthz').then(r => { if (!r.ok) process.exit(1) })"

# Use tini as init system
ENTRYPOINT ["tini", "--"]

# Start the service
CMD ["node", "packages/control-plane/dist/index.js"]
```

**Key design decisions in the Dockerfile:**

1. **Three-stage build** — `deps` (prod dependencies), `builder` (full build), `runtime` (minimal). This ensures devDependencies and source code never reach the runtime image.
2. **`tini` as PID 1** — Node.js doesn't handle signals (SIGTERM, SIGINT) correctly as PID 1. `tini` forwards signals properly, enabling graceful shutdown in k8s.
3. **Non-root user** — security baseline. The `cortex` user has no elevated privileges.
4. **`--frozen-lockfile`** — the build fails if `pnpm-lock.yaml` is out of date. No silent dependency drift.
5. **`HEALTHCHECK`** — Docker-level health check for `docker compose`. In k8s, the liveness/readiness probes in the pod spec supersede this.

---

## Artifact: docker-compose.yml

```yaml
# Development environment — not for production
# Usage: docker compose up -d
#         pnpm dev  (runs control plane + dashboard with hot reload against these services)

services:
  postgres:
    image: postgres:17-bookworm
    restart: unless-stopped
    environment:
      POSTGRES_USER: cortex
      POSTGRES_PASSWORD: cortex_dev
      POSTGRES_DB: cortex_plane
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cortex"]
      interval: 5s
      timeout: 3s
      retries: 5

  qdrant:
    image: qdrant/qdrant:v1.13.2
    restart: unless-stopped
    ports:
      - "6333:6333" # REST API
      - "6334:6334" # gRPC
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:6333/healthz || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3

  # Optional: run the control plane itself in Docker (alternative to `pnpm dev`)
  # Uncomment to use. Most developers will prefer running locally with hot reload.
  # control-plane:
  #   build:
  #     context: .
  #     dockerfile: docker/Dockerfile.control-plane
  #   restart: unless-stopped
  #   ports:
  #     - "4000:4000"
  #   environment:
  #     DATABASE_URL: postgres://cortex:cortex_dev@postgres:5432/cortex_plane
  #     QDRANT_URL: http://qdrant:6333
  #     NODE_ENV: development
  #     LOG_LEVEL: debug
  #   depends_on:
  #     postgres:
  #       condition: service_healthy
  #     qdrant:
  #       condition: service_healthy

volumes:
  pgdata:
  qdrant_data:
```

### `.env.example`

```bash
# Database
DATABASE_URL=postgres://cortex:cortex_dev@localhost:5432/cortex_plane

# Qdrant
QDRANT_URL=http://localhost:6333

# Server
PORT=4000
HOST=0.0.0.0
NODE_ENV=development
LOG_LEVEL=debug

# Graphile Worker
GRAPHILE_WORKER_CONCURRENCY=5

# Channel adapters (optional for dev)
# TELEGRAM_BOT_TOKEN=
# DISCORD_BOT_TOKEN=
```

---

## Artifact: ESLint + Prettier Config

### ESLint Strategy

We use **ESLint v9 flat config** with `typescript-eslint`. No legacy `.eslintrc` — flat config is the future and ESLint v9 is stable.

### `eslint.config.js` (Root)

```javascript
import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier"

export default tseslint.config(
  // Global ignores
  {
    ignores: ["**/dist/", "**/node_modules/", "**/.next/", "**/coverage/"],
  },

  // Base rules for all TypeScript files
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  // TypeScript project-aware linting
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Project-specific rules
  {
    rules: {
      // Enforce explicit return types on exported functions (API boundaries)
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowHigherOrderFunctions: true,
          allowTypedFunctionExpressions: true,
        },
      ],

      // No floating promises — every async call must be awaited or void-annotated
      "@typescript-eslint/no-floating-promises": "error",

      // No unused vars (allow underscore prefix for intentionally unused)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],

      // Prefer nullish coalescing over ||
      "@typescript-eslint/prefer-nullish-coalescing": "error",

      // Consistent type imports
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],

      // No console.log in production code (use pino logger)
      "no-console": "error",
    },
  },

  // Disable rules that conflict with Prettier
  eslintConfigPrettier,
)
```

### `.prettierrc`

```jsonc
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "endOfLine": "lf",
  "arrowParens": "always",
}
```

**Prettier rationale:**

- **`semi: true`** — explicit semicolons prevent ASI-related bugs. Removes ambiguity.
- **`singleQuote: false`** — double quotes are the JSON standard and TypeScript convention. No switching between `'` in TS and `"` in JSON.
- **`trailingComma: "all"`** — cleaner git diffs. Adding an item to an array/object doesn't modify the previous line.
- **`printWidth: 100`** — 80 is too narrow for TypeScript with generics and type annotations. 120 encourages overly long lines. 100 is the pragmatic middle.
- **`endOfLine: "lf"`** — Unix line endings. No CRLF in the repo, ever.

---

## Artifact: turbo.json

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"],
    },
    "dev": {
      "cache": false,
      "persistent": true,
    },
    "test": {
      "dependsOn": ["build"],
      "cache": false,
    },
    "typecheck": {
      "dependsOn": ["^build"],
    },
    "lint": {},
    "lint:fix": {},
    "clean": {
      "cache": false,
    },
  },
}
```

---

## Summary: Decision Matrix

| #   | Decision            | Choice                                          | Runner-up            | Key Rationale                                                                          |
| --- | ------------------- | ----------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| 1   | Monorepo tooling    | pnpm Workspaces + Turborepo                     | Bare pnpm workspaces | Turbo adds topological builds + caching at near-zero cost                              |
| 2   | Package manager     | pnpm                                            | Bun                  | We run Node.js, not Bun runtime; pnpm's strict resolution catches real bugs            |
| 3   | TypeScript config   | Strict, ESM-only, project refs                  | —                    | Node.js 24 has stable ESM; strict catches bugs; project refs enable incremental builds |
| 4   | ORM / Query builder | Kysely                                          | Drizzle              | Kysely doesn't conflict with Graphile Worker's schema management; shares pg driver     |
| 5   | HTTP framework      | Fastify                                         | Hono                 | Native Node.js framework; built-in Pino, Ajv, plugin encapsulation                     |
| 6   | Logging             | Pino                                            | Winston              | Fastify-native; 5x faster; structured JSON by default                                  |
| 7   | Config management   | @fastify/env                                    | convict              | Fastify-native; JSON Schema validation; fail-fast on startup                           |
| 8   | Docker base image   | node:24-slim                                    | node:24-alpine       | glibc compatibility; Playwright support; ARM64 reliability                             |
| —   | ESLint              | v9 flat config + typescript-eslint strict       | —                    | Modern, no legacy config; strict type-checked rules                                    |
| —   | Prettier            | Standard config, double quotes, trailing commas | —                    | Clean diffs, no ASI bugs, JSON consistency                                             |
| —   | Test runner         | Vitest                                          | Jest                 | ESM-native, fast, TypeScript without transform config                                  |
| —   | Dev runner          | tsx (watch mode)                                | ts-node              | tsx uses esbuild under the hood, fast startup, watch mode built-in                     |

---

## Open Questions (for future spikes)

1. **CI/CD pipeline** — GitHub Actions vs Gitea Actions vs ArgoCD? (Separate spike.)
2. **k8s manifests** — Helm vs Kustomize vs raw manifests? (Separate spike.)
3. **API authentication** — JWT vs API keys vs OAuth2? (Separate spike.)
4. **Dashboard state management** — React Query (TanStack Query) vs SWR? (Decide when dashboard work begins.)
5. **Agent pod template** — What base image for agent containers? What runtime? (Separate spike.)
