import { describe, expect, it } from "vitest"

import { isExpectedTeardownPgError } from "./postgres-teardown.js"

describe("postgres teardown helpers", () => {
  it("detects expected postgres shutdown race errors", () => {
    expect(
      isExpectedTeardownPgError({
        code: "57P01",
        message: "terminating connection due to administrator command",
      }),
    ).toBe(true)

    expect(
      isExpectedTeardownPgError({
        message: "Connection terminated unexpectedly",
      }),
    ).toBe(true)
  })

  it("does not swallow unrelated errors", () => {
    expect(
      isExpectedTeardownPgError({
        code: "23505",
        message: "duplicate key value violates unique constraint",
      }),
    ).toBe(false)
    expect(isExpectedTeardownPgError(new Error("boom"))).toBe(false)
  })
})
