/**
 * Capability Guard Errors
 */

export class ToolRateLimitError extends Error {
  constructor(
    public readonly toolRef: string,
    public readonly limit: { maxCalls: number; windowSeconds: number },
  ) {
    super(`Tool ${toolRef} rate limited: ${limit.maxCalls} calls per ${limit.windowSeconds}s`)
    this.name = "ToolRateLimitError"
  }
}

export class ToolApprovalRequiredError extends Error {
  constructor(
    public readonly toolRef: string,
    public readonly approvalRequestId: string,
  ) {
    super(`Tool ${toolRef} requires approval (request ${approvalRequestId})`)
    this.name = "ToolApprovalRequiredError"
  }
}
