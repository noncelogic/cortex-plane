/**
 * Capabilities Module — barrel export
 */

export { CapabilityAssembler } from "./assembler.js"
export type { RuntimeToolManifestRecord, RuntimeToolManifestToolRecord } from "./contracts.js"
export {
  buildRuntimeToolManifestFromEffectiveTools,
  buildRuntimeToolManifestFromToolDefinitions,
  isExecutableToolDefinition,
  toEffectiveToolContract,
} from "./contracts.js"
export type { DelegationRequest, ValidatedDelegation } from "./delegation.js"
export { narrowDataScope, validateDelegation } from "./delegation.js"
export { ToolApprovalRequiredError, ToolRateLimitError } from "./errors.js"
export { CapabilityGuard, evaluateCondition } from "./guard.js"
export type { EffectiveTool, EffectiveToolContract, EffectiveToolSourceKind } from "./types.js"
