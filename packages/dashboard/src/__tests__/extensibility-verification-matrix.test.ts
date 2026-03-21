import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

describe("extensibility verification matrix artifact", () => {
  const matrixPath = resolve(process.cwd(), "../../docs/audits/extensibility-verification-matrix-2026-03-21.md")
  const matrix = readFileSync(matrixPath, "utf8")

  it("links to issue #706 and scope", () => {
    expect(matrix).toContain("Issue #706")
    expect(matrix).toContain("Browser tooling")
    expect(matrix).toContain("MCP")
  })

  it("tracks partial checks with explicit follow-up tickets", () => {
    expect(matrix).toContain("⚠️ PARTIAL")
    expect(matrix).toContain("#711")
    expect(matrix).toContain("#712")
    expect(matrix).toContain("#713")
  })
})
