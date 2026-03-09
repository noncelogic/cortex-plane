/**
 * CI coverage audit (#493).
 *
 * Meta-test that verifies the CI test suite includes all required test
 * categories. Prevents regressions where required test files are
 * accidentally excluded from `pnpm test`.
 *
 * Required categories:
 *   1. Schema contract tests (#489) — dashboard Zod ↔ API fixture validation
 *   2. Agent lifecycle integration tests (#491) — quarantine / release / boot
 *   3. Chat session CRUD integration tests (#492) — create / list / send / delete
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

// Paths are relative to the monorepo root (two levels up from this file).
const MONOREPO_ROOT = resolve(__dirname, "../../../..")

/** Test files that must exist and must NOT be excluded from `pnpm test`. */
const REQUIRED_TEST_FILES = [
  {
    label: "Schema contract tests (#489)",
    path: "packages/dashboard/src/__tests__/schema-contract.test.ts",
  },
  {
    label: "Agent lifecycle integration tests (#491)",
    path: "packages/control-plane/src/__tests__/agent-lifecycle-full-integration.test.ts",
  },
  {
    label: "Chat session CRUD integration tests (#492)",
    path: "packages/control-plane/src/__tests__/chat-session-crud.test.ts",
  },
] as const

/**
 * Files that ARE intentionally excluded from CI because they require
 * external services (EmbeddedPostgres, graphile-worker, Qdrant).
 */
const INTENTIONALLY_EXCLUDED = [
  "memory-scheduling.integration.test",
  "migrations.test",
  "worker-integration.test",
] as const

describe("CI coverage audit (#493)", () => {
  for (const { label, path } of REQUIRED_TEST_FILES) {
    it(`${label} — file exists`, () => {
      const fullPath = resolve(MONOREPO_ROOT, path)
      expect(existsSync(fullPath), `Missing required test file: ${path}`).toBe(true)
    })
  }

  it("control-plane vitest config does not exclude required test files", () => {
    const configPath = resolve(MONOREPO_ROOT, "packages/control-plane/vitest.config.ts")
    const configText = readFileSync(configPath, "utf-8")

    for (const { label, path } of REQUIRED_TEST_FILES) {
      const fileName = path.split("/").pop()!
      const stem = fileName.replace(/\.test\.ts$/, "")
      expect(
        configText.includes(stem),
        `vitest config must NOT exclude ${label} (matched "${stem}")`,
      ).toBe(false)
    }
  })

  it("heavy integration tests are intentionally excluded", () => {
    const configPath = resolve(MONOREPO_ROOT, "packages/control-plane/vitest.config.ts")
    const configText = readFileSync(configPath, "utf-8")

    for (const stem of INTENTIONALLY_EXCLUDED) {
      expect(
        configText.includes(stem),
        `vitest config should exclude ${stem} (needs external services)`,
      ).toBe(true)
    }
  })

  it("CI workflow runs the test step", () => {
    const ciPath = resolve(MONOREPO_ROOT, ".github/workflows/ci.yml")
    const ciText = readFileSync(ciPath, "utf-8")

    expect(ciText).toContain("pnpm test")
    expect(ciText).toContain("schema-contract")
    expect(ciText).toContain("integration")
  })
})
