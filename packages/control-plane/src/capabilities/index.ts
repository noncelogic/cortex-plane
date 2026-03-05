/**
 * Capabilities Module — barrel export
 */

export { CapabilityAssembler } from "./assembler.js"
export { CapabilityGuard } from "./guard.js"
export { ToolApprovalRequiredError, ToolRateLimitError } from "./errors.js"
export type { EffectiveTool } from "./types.js"
export { validateDelegation, narrowDataScope } from "./delegation.js"
export type { DelegationRequest, ValidatedDelegation } from "./delegation.js"
