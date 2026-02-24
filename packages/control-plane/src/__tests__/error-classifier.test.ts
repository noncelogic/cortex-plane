import { describe, expect, it } from "vitest"

import { classifyError, type ErrorClassification } from "../worker/error-classifier.js"

describe("classifyError", () => {
  describe("HTTP status codes", () => {
    it("classifies 429 as TRANSIENT (rate limit)", () => {
      const error = Object.assign(new Error("Too Many Requests"), { status: 429 })
      const result = classifyError(error)
      expect(result.category).toBe("TRANSIENT")
      expect(result.retryable).toBe(true)
    })

    it("classifies 502 as TRANSIENT (bad gateway)", () => {
      const error = Object.assign(new Error("Bad Gateway"), { status: 502 })
      const result = classifyError(error)
      expect(result.category).toBe("TRANSIENT")
      expect(result.retryable).toBe(true)
    })

    it("classifies 503 as TRANSIENT (service unavailable)", () => {
      const error = Object.assign(new Error("Service Unavailable"), { status: 503 })
      const result = classifyError(error)
      expect(result.category).toBe("TRANSIENT")
      expect(result.retryable).toBe(true)
    })

    it("classifies 529 as TRANSIENT (overloaded)", () => {
      const error = Object.assign(new Error("Overloaded"), { status: 529 })
      const result = classifyError(error)
      expect(result.category).toBe("TRANSIENT")
      expect(result.retryable).toBe(true)
    })

    it("classifies 400 as PERMANENT (bad request)", () => {
      const error = Object.assign(new Error("Bad Request"), { status: 400 })
      const result = classifyError(error)
      expect(result.category).toBe("PERMANENT")
      expect(result.retryable).toBe(false)
    })

    it("classifies 401 as PERMANENT (unauthorized)", () => {
      const error = Object.assign(new Error("Unauthorized"), { status: 401 })
      const result = classifyError(error)
      expect(result.category).toBe("PERMANENT")
      expect(result.retryable).toBe(false)
    })

    it("classifies 404 as PERMANENT (not found)", () => {
      const error = Object.assign(new Error("Not Found"), { status: 404 })
      const result = classifyError(error)
      expect(result.category).toBe("PERMANENT")
      expect(result.retryable).toBe(false)
    })

    it("classifies 408 as TIMEOUT (request timeout)", () => {
      const error = Object.assign(new Error("Request Timeout"), { status: 408 })
      const result = classifyError(error)
      expect(result.category).toBe("TIMEOUT")
      expect(result.retryable).toBe(true)
    })

    it("classifies 504 as TIMEOUT (gateway timeout)", () => {
      const error = Object.assign(new Error("Gateway Timeout"), { status: 504 })
      const result = classifyError(error)
      expect(result.category).toBe("TIMEOUT")
      expect(result.retryable).toBe(true)
    })

    it("classifies 500 as TRANSIENT (internal server error)", () => {
      const error = Object.assign(new Error("Internal Server Error"), { status: 500 })
      const result = classifyError(error)
      expect(result.category).toBe("TRANSIENT")
      expect(result.retryable).toBe(true)
    })
  })

  describe("Node.js error codes", () => {
    it("classifies ECONNRESET as TRANSIENT", () => {
      const error = Object.assign(new Error("Connection reset"), { code: "ECONNRESET" })
      const result = classifyError(error)
      expect(result.category).toBe("TRANSIENT")
      expect(result.retryable).toBe(true)
    })

    it("classifies ECONNREFUSED as TRANSIENT", () => {
      const error = Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" })
      const result = classifyError(error)
      expect(result.category).toBe("TRANSIENT")
      expect(result.retryable).toBe(true)
    })

    it("classifies ETIMEDOUT as TRANSIENT", () => {
      const error = Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" })
      const result = classifyError(error)
      expect(result.category).toBe("TRANSIENT")
      expect(result.retryable).toBe(true)
    })

    it("classifies ENOTFOUND as PERMANENT (DNS permanent failure)", () => {
      const error = Object.assign(new Error("DNS not found"), { code: "ENOTFOUND" })
      const result = classifyError(error)
      expect(result.category).toBe("PERMANENT")
      expect(result.retryable).toBe(false)
    })

    it("classifies ENOENT as PERMANENT", () => {
      const error = Object.assign(new Error("File not found"), { code: "ENOENT" })
      const result = classifyError(error)
      expect(result.category).toBe("PERMANENT")
      expect(result.retryable).toBe(false)
    })

    it("classifies ENOMEM as RESOURCE", () => {
      const error = Object.assign(new Error("Out of memory"), { code: "ENOMEM" })
      const result = classifyError(error)
      expect(result.category).toBe("RESOURCE")
      expect(result.retryable).toBe(true)
    })

    it("classifies ENOSPC as RESOURCE (disk full)", () => {
      const error = Object.assign(new Error("No space left"), { code: "ENOSPC" })
      const result = classifyError(error)
      expect(result.category).toBe("RESOURCE")
      expect(result.retryable).toBe(true)
    })
  })

  describe("special error types", () => {
    it("classifies AbortError as TIMEOUT", () => {
      const error = new DOMException("Operation aborted", "AbortError")
      const result = classifyError(error)
      expect(result.category).toBe("TIMEOUT")
      expect(result.retryable).toBe(true)
    })

    it("classifies timeout keyword in message as TIMEOUT", () => {
      const error = new Error("Operation timeout after 30000ms")
      const result = classifyError(error)
      expect(result.category).toBe("TIMEOUT")
      expect(result.retryable).toBe(true)
    })

    it("classifies OOM keyword in message as RESOURCE", () => {
      const error = new Error("JavaScript heap out of memory")
      const result = classifyError(error)
      expect(result.category).toBe("RESOURCE")
      expect(result.retryable).toBe(true)
    })
  })

  describe("SDK errors by constructor name", () => {
    function makeSDKError(name: string, message: string): Error {
      const error = new Error(message)
      Object.defineProperty(error, "constructor", { value: { name } })
      return error
    }

    it("classifies RateLimitError as RESOURCE", () => {
      const result = classifyError(makeSDKError("RateLimitError", "Rate limit"))
      expect(result.category).toBe("RESOURCE")
      expect(result.retryable).toBe(true)
    })

    it("classifies AuthenticationError as PERMANENT", () => {
      const result = classifyError(makeSDKError("AuthenticationError", "Auth failed"))
      expect(result.category).toBe("PERMANENT")
      expect(result.retryable).toBe(false)
    })

    it("classifies BadRequestError as PERMANENT", () => {
      const result = classifyError(makeSDKError("BadRequestError", "Bad request"))
      expect(result.category).toBe("PERMANENT")
      expect(result.retryable).toBe(false)
    })

    it("classifies APIConnectionError as TRANSIENT", () => {
      const result = classifyError(makeSDKError("APIConnectionError", "Connection error"))
      expect(result.category).toBe("TRANSIENT")
      expect(result.retryable).toBe(true)
    })

    it("classifies OverloadedError as RESOURCE", () => {
      const result = classifyError(makeSDKError("OverloadedError", "Overloaded"))
      expect(result.category).toBe("RESOURCE")
      expect(result.retryable).toBe(true)
    })
  })

  describe("edge cases", () => {
    it("classifies non-Error values as UNKNOWN", () => {
      const result = classifyError("some string error")
      expect(result.category).toBe("UNKNOWN")
      expect(result.retryable).toBe(true)
    })

    it("classifies null as UNKNOWN", () => {
      const result = classifyError(null)
      expect(result.category).toBe("UNKNOWN")
      expect(result.retryable).toBe(true)
    })

    it("classifies plain Error with no code/status as UNKNOWN", () => {
      const result = classifyError(new Error("Something went wrong"))
      expect(result.category).toBe("UNKNOWN")
      expect(result.retryable).toBe(true)
    })

    it("returns consistent shape", () => {
      const result: ErrorClassification = classifyError(new Error("test"))
      expect(result).toHaveProperty("category")
      expect(result).toHaveProperty("retryable")
      expect(result).toHaveProperty("message")
    })
  })
})
